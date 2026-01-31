/**
 * FFmpeg/ffprobe wrapper for segment removal
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const execFileAsync = promisify(execFile);
const fsPromises = fs.promises;

// Constants for storyboard generation (from PeerTube)
const STORYBOARD_SPRITE_MAX_SIZE = 192;
const STORYBOARD_SPRITES_MAX_EDGE_COUNT = 11;
const FFMPEG_TIMEOUT_MS = 300000;

/**
 * Get video duration in seconds using ffprobe
 */
async function getVideoDuration(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ]);

  const duration = parseFloat(stdout.trim());
  if (isNaN(duration) || duration <= 0) {
    throw new Error(`Invalid duration for ${filePath}: ${stdout.trim()}`);
  }

  return duration;
}

/**
 * Compute the segments to keep (inverse of sponsor segments)
 * Returns array of { start, end } representing parts to preserve
 */
function computeKeepSegments(segments, duration) {
  if (!segments || segments.length === 0) {
    return [{ start: 0, end: duration }];
  }

  // Sort by start_time and merge overlapping segments
  const sorted = segments
    .map(s => ({ start: parseFloat(s.start_time), end: parseFloat(s.end_time) }))
    .sort((a, b) => a.start - b.start);

  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push(sorted[i]);
    }
  }

  // Invert to get keep segments
  const keep = [];

  if (merged[0].start > 0) {
    keep.push({ start: 0, end: merged[0].start });
  }

  for (let i = 0; i < merged.length - 1; i++) {
    keep.push({ start: merged[i].end, end: merged[i + 1].start });
  }

  if (merged[merged.length - 1].end < duration) {
    keep.push({ start: merged[merged.length - 1].end, end: duration });
  }

  // Filter out segments shorter than 0.1s
  const filtered = keep.filter(s => (s.end - s.start) >= 0.1);

  if (filtered.length === 0) {
    throw new Error('No content remaining after removing sponsor segments');
  }

  return filtered;
}

/**
 * Process a video file by removing sponsor segments using FFmpeg
 * Cuts the keep segments and concatenates them back together
 */
async function processVideoFile(filePath, segments, duration, logger) {
  const ext = path.extname(filePath);
  const tmpDir = path.join(os.tmpdir(), `sponsorblock-${crypto.randomBytes(8).toString('hex')}`);

  await fsPromises.mkdir(tmpDir, { recursive: true });

  try {
    const keepSegments = computeKeepSegments(segments, duration);
    logger.info(`Processing ${filePath}: ${keepSegments.length} segments to keep`);

    // Extract each keep segment
    const partFiles = [];
    for (let i = 0; i < keepSegments.length; i++) {
      const seg = keepSegments[i];
      const partFile = path.join(tmpDir, `part${i}${ext}`);
      partFiles.push(partFile);

      await execFileAsync('ffmpeg', [
        '-y',
        '-i', filePath,
        '-ss', String(seg.start),
        '-to', String(seg.end),
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        partFile
      ], { timeout: FFMPEG_TIMEOUT_MS });
    }

    // Write concat file
    const concatFile = path.join(tmpDir, 'concat.txt');
    const concatContent = partFiles.map(f => `file '${f}'`).join('\n');
    await fsPromises.writeFile(concatFile, concatContent);

    // Concatenate all parts
    const outputFile = path.join(tmpDir, `output${ext}`);
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-c', 'copy',
      outputFile
    ], { timeout: 600000 });

    // Validate output
    const stat = await fsPromises.stat(outputFile);
    if (stat.size === 0) {
      throw new Error('Output file is empty');
    }

    // Replace original with output
    await fsPromises.copyFile(outputFile, filePath);

    logger.info(`Successfully processed ${filePath} (${stat.size} bytes)`);
  } finally {
    // Cleanup temp directory
    await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Find all local video files for a given video UUID
 * Searches web-videos, HLS streaming playlists, and original files
 */
async function findVideoFiles(database, videoUuid, storagePath, logger) {
  const files = [];

  try {
    // Get video ID from UUID
    const [videos] = await database.query(
      'SELECT "id" FROM "video" WHERE "uuid" = $1',
      { bind: [videoUuid] }
    );

    if (!videos || videos.length === 0) {
      logger.warn(`Video not found: ${videoUuid}`);
      return files;
    }

    const videoId = videos[0].id;

    // Find web-video files (storage = 0 means local)
    const [webVideoFiles] = await database.query(
      'SELECT "filename" FROM "videoFile" WHERE "videoId" = $1 AND "storage" = 0',
      { bind: [videoId] }
    );

    for (const row of (webVideoFiles || [])) {
      const baseDir = path.resolve(storagePath, 'web-videos');
      const filePath = path.resolve(baseDir, row.filename);
      if (!filePath.startsWith(baseDir + path.sep)) {
        logger.warn(`Path traversal blocked for web-video: ${row.filename}`);
        continue;
      }
      if (await fileExists(filePath)) {
        files.push({ type: 'web-video', path: filePath });
      }
    }

    // Find HLS files via videoStreamingPlaylist
    const [playlists] = await database.query(
      'SELECT "id" FROM "videoStreamingPlaylist" WHERE "videoId" = $1',
      { bind: [videoId] }
    );

    for (const playlist of (playlists || [])) {
      const [hlsFiles] = await database.query(
        'SELECT "filename" FROM "videoFile" WHERE "videoStreamingPlaylistId" = $1 AND "storage" = 0',
        { bind: [playlist.id] }
      );

      for (const row of (hlsFiles || [])) {
        const baseDir = path.resolve(storagePath, 'streaming-playlists', 'hls', videoUuid);
        const filePath = path.resolve(baseDir, row.filename);
        if (!filePath.startsWith(baseDir + path.sep)) {
          logger.warn(`Path traversal blocked for HLS file: ${row.filename}`);
          continue;
        }
        if (await fileExists(filePath)) {
          files.push({ type: 'hls', path: filePath });
        }
      }
    }

    // Find original video files (glob for uuid in filename)
    const originalDir = path.resolve(storagePath, 'original-video-files');
    if (await fileExists(originalDir)) {
      const entries = await fsPromises.readdir(originalDir);
      for (const entry of entries) {
        if (entry.includes(videoUuid)) {
          const filePath = path.resolve(originalDir, entry);
          if (!filePath.startsWith(originalDir + path.sep)) {
            logger.warn(`Path traversal blocked for original file: ${entry}`);
            continue;
          }
          files.push({ type: 'original', path: filePath });
        }
      }
    }
  } catch (error) {
    logger.error(`Error finding video files for ${videoUuid}`, error);
  }

  logger.info(`Found ${files.length} local file(s) for video ${videoUuid}`);
  return files;
}

/**
 * After processing an HLS fMP4 file, regenerate the .m3u8 playlist
 * and the segments-sha256.json hash manifest
 */
async function regenerateHlsMetadata(fmp4Path, logger) {
  const dir = path.dirname(fmp4Path);
  const fmp4Name = path.basename(fmp4Path);
  // {uuid}-{resolution}-fragmented.mp4 -> {uuid}-{resolution}.m3u8
  const m3u8Name = fmp4Name.replace('-fragmented.mp4', '.m3u8');
  const m3u8Path = path.join(dir, m3u8Name);

  const tmpDir = path.join(os.tmpdir(), `sponsorblock-hls-${crypto.randomBytes(8).toString('hex')}`);
  await fsPromises.mkdir(tmpDir, { recursive: true });

  try {
    const tmpM3u8 = path.join(tmpDir, 'output.m3u8');
    const tmpFmp4 = path.join(tmpDir, 'output.m4s');

    // Regenerate HLS playlist + fMP4 from the processed file
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', fmp4Path,
      '-c', 'copy',
      '-f', 'hls',
      '-hls_segment_type', 'fmp4',
      '-hls_flags', 'single_file',
      '-hls_playlist_type', 'vod',
      '-hls_time', '10',
      tmpM3u8
    ], { timeout: FFMPEG_TIMEOUT_MS });

    // Replace the fMP4 and m3u8 with regenerated versions
    await fsPromises.copyFile(tmpFmp4, fmp4Path);
    await fsPromises.copyFile(tmpM3u8, m3u8Path);

    logger.info(`Regenerated HLS playlist: ${m3u8Name}`);
  } finally {
    await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  // Regenerate segments-sha256.json for the entire HLS directory
  await regenerateSegmentHashes(dir, logger);
}

/**
 * Regenerate segments-sha256.json by parsing all m3u8 playlists
 * and computing SHA-256 hashes for each byte range
 */
async function regenerateSegmentHashes(hlsDir, logger) {
  const sha256Path = path.join(hlsDir, 'segments-sha256.json');
  const hashes = {};

  const entries = await fsPromises.readdir(hlsDir);
  const m3u8Files = entries.filter(e => e.endsWith('.m3u8') && e !== 'master.m3u8');

  for (const m3u8File of m3u8Files) {
    const m3u8Content = await fsPromises.readFile(path.join(hlsDir, m3u8File), 'utf8');
    const fmp4Name = m3u8File.replace('.m3u8', '-fragmented.mp4');
    const fmp4Path = path.join(hlsDir, fmp4Name);

    if (!await fileExists(fmp4Path)) continue;

    const fmp4Data = await fsPromises.readFile(fmp4Path);
    const lines = m3u8Content.split('\n');

    for (const line of lines) {
      if (!line.startsWith('#EXT-X-BYTERANGE:') && !line.startsWith('#EXT-X-MAP:')) continue;

      const byterangeMatch = line.match(/#EXT-X-BYTERANGE:(\d+)@(\d+)/);
      const mapMatch = line.match(/BYTERANGE="(\d+)@(\d+)"/);
      const match = byterangeMatch || mapMatch;

      if (!match) continue;

      const length = parseInt(match[1]);
      const offset = parseInt(match[2]);

      const segment = fmp4Data.slice(offset, offset + length);
      const hash = crypto.createHash('sha256').update(segment).digest('hex');
      hashes[`${fmp4Name}/${offset}-${offset + length}`] = hash;
    }
  }

  await fsPromises.writeFile(sha256Path, JSON.stringify(hashes));
  logger.info(`Regenerated segment hashes: ${Object.keys(hashes).length} entries`);
}

/**
 * Regenerate storyboard sprite sheet after segment removal.
 * Replicates PeerTube's storyboard generation algorithm to create accurate
 * timeline thumbnails after cutting sponsor segments.
 *
 * @param {string} videoPath - Path to the processed video file
 * @param {string} videoUuid - Video UUID for DB lookup
 * @param {object} database - PeerTube database query interface
 * @param {string} storagePath - PeerTube storage root path
 * @param {object} logger - PeerTube logger instance
 * @returns {Promise<void>}
 */
async function regenerateStoryboard(videoPath, videoUuid, database, storagePath, logger) {
  // Step 1: Get video dimensions via ffprobe
  let width, height;
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'json',
      videoPath
    ]);
    const probe = JSON.parse(stdout);
    const stream = probe.streams && probe.streams[0];
    if (!stream || !stream.width || !stream.height) {
      logger.error(`Storyboard: ffprobe returned no video stream for ${videoPath}`);
      return;
    }
    width = stream.width;
    height = stream.height;
  } catch (error) {
    logger.error(`Storyboard: ffprobe failed for ${videoPath}`, error);
    return;
  }

  // Step 2: Compute sprite size (replicate PeerTube logic)
  const ratio = width / height;
  const isPortrait = height > width;
  let spriteWidth, spriteHeight;
  if (isPortrait) {
    spriteHeight = STORYBOARD_SPRITE_MAX_SIZE;
    spriteWidth = Math.round(STORYBOARD_SPRITE_MAX_SIZE * ratio);
  } else {
    spriteWidth = STORYBOARD_SPRITE_MAX_SIZE;
    spriteHeight = Math.round(STORYBOARD_SPRITE_MAX_SIZE / ratio);
  }

  // Step 3: Get new video duration
  let duration;
  try {
    duration = await getVideoDuration(videoPath);
  } catch (error) {
    logger.error(`Storyboard: failed to get duration for ${videoPath}`, error);
    return;
  }

  if (duration < 3) {
    logger.warn(`Storyboard: video too short (${duration}s), skipping`);
    return;
  }

  // Step 4: Compute sprite count (replicate PeerTube logic)
  const maxSprites = Math.min(Math.ceil(duration), STORYBOARD_SPRITES_MAX_EDGE_COUNT * STORYBOARD_SPRITES_MAX_EDGE_COUNT);
  const spriteDuration = Math.ceil(duration / maxSprites);
  const totalSprites = Math.ceil(duration / spriteDuration);

  // Step 5: Compute grid layout (replicate PeerTube findGridSize)
  // Find the most square grid that fits all sprites
  let gridW = 1;
  let gridH = 1;
  const minSize = Math.ceil(Math.sqrt(totalSprites));
  for (let w = minSize; w <= STORYBOARD_SPRITES_MAX_EDGE_COUNT; w++) {
    const h = Math.ceil(totalSprites / w);
    if (h <= STORYBOARD_SPRITES_MAX_EDGE_COUNT) {
      gridW = w;
      gridH = h;
      break;
    }
  }

  // Step 6: Find existing storyboard in DB
  let storyboardRow;
  try {
    const [rows] = await database.query(
      `SELECT s."id", s."filename" FROM "storyboard" s
       JOIN "video" v ON v."id" = s."videoId"
       WHERE v."uuid" = $1`,
      { bind: [videoUuid] }
    );
    if (!rows || rows.length === 0) {
      logger.info(`Storyboard: no storyboard found in DB for ${videoUuid}, skipping`);
      return;
    }
    storyboardRow = rows[0];
  } catch (error) {
    logger.error(`Storyboard: DB query failed for ${videoUuid}`, error);
    return;
  }

  // Step 7: Generate new sprite sheet via FFmpeg
  const storyboardPath = path.join(storagePath, 'storyboards', storyboardRow.filename);
  const storyboardDir = path.join(storagePath, 'storyboards');

  // Ensure storyboards directory exists
  if (!await fileExists(storyboardDir)) {
    logger.warn(`Storyboard: storyboards directory does not exist at ${storyboardDir}, skipping`);
    return;
  }

  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', videoPath,
      '-filter_complex',
      `setpts='N/FRAME_RATE/TB',select='isnan(prev_selected_t)+gte(t-prev_selected_t,${spriteDuration})',scale=${spriteWidth}:${spriteHeight},tile=layout=${gridW}x${gridH}`,
      '-frames:v', '1',
      '-q:v', '2',
      storyboardPath
    ], { timeout: FFMPEG_TIMEOUT_MS });

    logger.info(`Storyboard: generated sprite sheet ${storyboardRow.filename} (${gridW}x${gridH} grid, ${totalSprites} sprites)`);
  } catch (error) {
    logger.error(`Storyboard: FFmpeg generation failed for ${videoUuid}`, error);
    return;
  }

  // Step 8: Update storyboard table
  const totalWidth = spriteWidth * gridW;
  const totalHeight = spriteHeight * gridH;

  try {
    await database.query(
      `UPDATE "storyboard" SET
        "totalWidth" = $2, "totalHeight" = $3,
        "spriteWidth" = $4, "spriteHeight" = $5,
        "spriteDuration" = $6, "updatedAt" = NOW()
       WHERE "id" = $1`,
      { bind: [storyboardRow.id, totalWidth, totalHeight, spriteWidth, spriteHeight, spriteDuration] }
    );
    logger.info(`Storyboard: updated DB for ${videoUuid} (${totalWidth}x${totalHeight}, sprite ${spriteWidth}x${spriteHeight}, interval ${spriteDuration}s)`);
  } catch (error) {
    logger.error(`Storyboard: DB update failed for ${videoUuid}`, error);
  }
}

async function fileExists(filePath) {
  try {
    await fsPromises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getVideoDuration,
  computeKeepSegments,
  processVideoFile,
  findVideoFiles,
  regenerateHlsMetadata,
  regenerateStoryboard
};
