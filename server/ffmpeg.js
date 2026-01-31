/**
 * FFmpeg/ffprobe wrapper for segment removal
 */

const { execFile } = require('child_process')
const { promisify } = require('util')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const execFileAsync = promisify(execFile)
const fsPromises = fs.promises

/**
 * Get video duration in seconds using ffprobe
 */
async function getVideoDuration(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ])

  const duration = parseFloat(stdout.trim())
  if (isNaN(duration) || duration <= 0) {
    throw new Error(`Invalid duration for ${filePath}: ${stdout.trim()}`)
  }

  return duration
}

/**
 * Compute the segments to keep (inverse of sponsor segments)
 * Returns array of { start, end } representing parts to preserve
 */
function computeKeepSegments(segments, duration) {
  if (!segments || segments.length === 0) {
    return [{ start: 0, end: duration }]
  }

  // Sort by start_time and merge overlapping segments
  const sorted = segments
    .map(s => ({ start: parseFloat(s.start_time), end: parseFloat(s.end_time) }))
    .sort((a, b) => a.start - b.start)

  const merged = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end)
    } else {
      merged.push(sorted[i])
    }
  }

  // Invert to get keep segments
  const keep = []

  if (merged[0].start > 0) {
    keep.push({ start: 0, end: merged[0].start })
  }

  for (let i = 0; i < merged.length - 1; i++) {
    keep.push({ start: merged[i].end, end: merged[i + 1].start })
  }

  if (merged[merged.length - 1].end < duration) {
    keep.push({ start: merged[merged.length - 1].end, end: duration })
  }

  // Filter out segments shorter than 0.1s
  const filtered = keep.filter(s => (s.end - s.start) >= 0.1)

  if (filtered.length === 0) {
    throw new Error('No content remaining after removing sponsor segments')
  }

  return filtered
}

/**
 * Process a video file by removing sponsor segments using FFmpeg
 * Cuts the keep segments and concatenates them back together
 */
async function processVideoFile(filePath, segments, duration, logger) {
  const ext = path.extname(filePath)
  const tmpDir = path.join(os.tmpdir(), `sponsorblock-${crypto.randomBytes(8).toString('hex')}`)

  await fsPromises.mkdir(tmpDir, { recursive: true })

  try {
    const keepSegments = computeKeepSegments(segments, duration)
    logger.info(`Processing ${filePath}: ${keepSegments.length} segments to keep`)

    // Extract each keep segment
    const partFiles = []
    for (let i = 0; i < keepSegments.length; i++) {
      const seg = keepSegments[i]
      const partFile = path.join(tmpDir, `part${i}${ext}`)
      partFiles.push(partFile)

      await execFileAsync('ffmpeg', [
        '-y',
        '-i', filePath,
        '-ss', String(seg.start),
        '-to', String(seg.end),
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        partFile
      ], { timeout: 300000 })
    }

    // Write concat file
    const concatFile = path.join(tmpDir, 'concat.txt')
    const concatContent = partFiles.map(f => `file '${f}'`).join('\n')
    await fsPromises.writeFile(concatFile, concatContent)

    // Concatenate all parts
    const outputFile = path.join(tmpDir, `output${ext}`)
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-c', 'copy',
      outputFile
    ], { timeout: 600000 })

    // Validate output
    const stat = await fsPromises.stat(outputFile)
    if (stat.size === 0) {
      throw new Error('Output file is empty')
    }

    // Replace original with output
    await fsPromises.copyFile(outputFile, filePath)

    logger.info(`Successfully processed ${filePath} (${stat.size} bytes)`)
  } finally {
    // Cleanup temp directory
    await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Find all local video files for a given video UUID
 * Searches web-videos, HLS streaming playlists, and original files
 */
async function findVideoFiles(database, videoUuid, storagePath, logger) {
  const files = []

  try {
    // Get video ID from UUID
    const [videos] = await database.query(
      'SELECT "id" FROM "video" WHERE "uuid" = $1',
      { bind: [videoUuid] }
    )

    if (!videos || videos.length === 0) {
      logger.warn(`Video not found: ${videoUuid}`)
      return files
    }

    const videoId = videos[0].id

    // Find web-video files (storage = 0 means local)
    const [webVideoFiles] = await database.query(
      'SELECT "filename" FROM "videoFile" WHERE "videoId" = $1 AND "storage" = 0',
      { bind: [videoId] }
    )

    for (const row of (webVideoFiles || [])) {
      const filePath = path.join(storagePath, 'web-videos', row.filename)
      if (await fileExists(filePath)) {
        files.push({ type: 'web-video', path: filePath })
      }
    }

    // Find HLS files via videoStreamingPlaylist
    const [playlists] = await database.query(
      'SELECT "id" FROM "videoStreamingPlaylist" WHERE "videoId" = $1',
      { bind: [videoId] }
    )

    for (const playlist of (playlists || [])) {
      const [hlsFiles] = await database.query(
        'SELECT "filename" FROM "videoFile" WHERE "videoStreamingPlaylistId" = $1 AND "storage" = 0',
        { bind: [playlist.id] }
      )

      for (const row of (hlsFiles || [])) {
        const filePath = path.join(storagePath, 'streaming-playlists', 'hls', videoUuid, row.filename)
        if (await fileExists(filePath)) {
          files.push({ type: 'hls', path: filePath })
        }
      }
    }

    // Find original video files (glob for uuid in filename)
    const originalDir = path.join(storagePath, 'original-video-files')
    if (await fileExists(originalDir)) {
      const entries = await fsPromises.readdir(originalDir)
      for (const entry of entries) {
        if (entry.includes(videoUuid)) {
          const filePath = path.join(originalDir, entry)
          files.push({ type: 'original', path: filePath })
        }
      }
    }
  } catch (error) {
    logger.error(`Error finding video files for ${videoUuid}`, error)
  }

  logger.info(`Found ${files.length} local file(s) for video ${videoUuid}`)
  return files
}

async function fileExists(filePath) {
  try {
    await fsPromises.access(filePath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

module.exports = {
  getVideoDuration,
  computeKeepSegments,
  processVideoFile,
  findVideoFiles
}
