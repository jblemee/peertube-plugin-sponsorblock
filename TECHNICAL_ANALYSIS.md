# Technical Analysis: Permanent Removal of Sponsor Segments

**Date**: 2026-01-31
**Goal**: Analyze the feasibility of modifying video files at the source to permanently remove sponsor segments detected by SponsorBlock.

---

## Table of Contents

1. [PeerTube Storage Architecture](#peertube-storage-architecture)
2. [Transcoding System](#transcoding-system)
3. [Segment Removal Approach](#segment-removal-approach)
4. [FFmpeg Implementation](#ffmpeg-implementation)
5. [Job Management](#job-management)
6. [Challenges and Risks](#challenges-and-risks)
7. [Recommendations](#recommendations)

---

## PeerTube Storage Architecture

### Directory Structure

PeerTube stores videos in `/var/www/peertube/storage/` with several subdirectories:

```
/var/www/peertube/storage/
├── tmp/                        # Temporary downloads, uploads in progress
├── tmp_persistent/             # Persistent tmp across restarts
├── original-video-files/       # Original uploaded video files
├── web-videos/                 # Web videos (different resolutions)
├── streaming-playlists/        # HLS playlists for adaptive streaming
│   └── hls/                    # HLS segments
├── redundancy/                 # Redundancy copies
├── previews/                   # Video thumbnails
├── avatars/                    # User avatars
└── logs/                       # Logs
```

**Source**: [An Admin's Guide to Fixing PeerTube](https://wedistribute.org/2024/07/fixing-peertube-videos/)

### Video File Types

For each uploaded video, PeerTube generates several versions:

1. **Original file** (`original-video-files/`)
   - File as uploaded by the user
   - Kept for archiving or later re-transcoding

2. **Web videos** (`web-videos/`)
   - Versions transcoded in multiple resolutions (240p, 360p, 480p, 720p, 1080p, etc.)
   - Format optimized for WebTorrent P2P streaming

3. **HLS playlists** (`streaming-playlists/hls/`)
   - Video segments for adaptive streaming
   - `.m3u8` (playlists) + `.ts` or `.m4s` segments

### Object Storage Support

PeerTube can use S3/MinIO for remote storage:
- `web_videos` prefix
- `streaming_playlists` prefix
- `original_video_files` prefix

**Implication**: The plugin must handle both local and remote storage.

**Source**: [Remote storage (S3)](https://docs.joinpeertube.org/maintain/remote-storage)

---

## Transcoding System

### Job Architecture

PeerTube uses **Bull** (based on Redis) to manage the job queue:

```
User upload → Import job → Transcoding jobs → Video available
                               ├─ Resolution 1 (480p)
                               ├─ Resolution 2 (720p)
                               └─ Resolution 3 (1080p)
```

**Processing flow**:
1. Upload/import of the video → storage in `original-video-files/`
2. Transcoding job created in the Redis queue
3. FFmpeg worker processes the video
4. Resolution generation in `web-videos/` and/or `streaming-playlists/`
5. Database update with metadata

**Source**: [Architecture | PeerTube documentation](https://docs.joinpeertube.org/contribute/architecture)

### Transcoding API for Plugins

Since PeerTube 3.1, plugins can modify transcoding via `transcodingManager`:

```javascript
async function register ({ transcodingManager }) {

  // Register a custom transcoding profile
  const builder = (options) => {
    return {
      inputOptions: [],
      outputOptions: [
        '-vcodec libx264',
        '-acodec aac'
      ]
    };
  };

  const encoder = 'custom-encoder';
  const priority = 100;

  transcodingManager.addVODProfile(encoder, priority, builder);
  transcodingManager.addVODEncoderPriority('video', encoder, priority);
}
```

**Limitations**:
- Modifies the **transcoding profile** (FFmpeg parameters)
- Does not allow injecting code **before** or **after** transcoding
- No hook to intercept/modify existing jobs

**Source**: [PeerTube 3.1 Is Released](https://linuxreviews.org/PeerTube_3.1_Is_Released_With_Advanced_Transcoding_Options_And_A_More_Polished_User-Interface)

### Remote Transcoding Runners

PeerTube supports remote transcoding:
- Runners connect via HTTP/WebSocket
- Jobs stored in DB and assigned to runners
- Allows offloading the main server

**Implication**: If the instance uses remote runners, the plugin must be able to access them or operate after transcoding.

**Source**: [Support for transcoding by remote workers](https://github.com/Chocobozzz/PeerTube/issues/947)

---

## Segment Removal Approach

### Option 1: Post-import modification (before transcoding)

**Timing**: Right after import, before transcoding.

**Workflow**:
```
YouTube Import → Fetch SponsorBlock segments → Modify original file → Start transcoding
```

**Advantages**:
- Single modification of the original file
- All generated resolutions will already be cleaned
- Maximum bandwidth and storage savings

**Disadvantages**:
- Must intercept **before** transcoding (hook available?)
- Delays video availability
- Complex to synchronize with the job system

**Potential hook**:
```javascript
registerHook({
  target: 'filter:api.video.post-import-url.accept.result',
  handler: async (result, params) => {
    const { videoImport } = params;

    // 1. Fetch SponsorBlock segments
    // 2. Modify original file
    // 3. Let transcoding proceed normally

    return result;
  }
});
```

### Option 2: Post-transcoding modification

**Timing**: After transcoding, modify all generated versions.

**Workflow**:
```
Import → Transcoding → Video available → Fetch segments → Re-process all files
```

**Advantages**:
- Video available quickly (no blocking)
- Can work on existing videos
- Easier to implement (async)

**Disadvantages**:
- Must process **all** resolutions (480p, 720p, 1080p, etc.)
- Significant CPU usage (partial re-transcoding)
- Double temporary storage

**Potential hook**:
```javascript
registerHook({
  target: 'action:api.video.updated',
  handler: async ({ video }) => {
    // Check if transcoding is complete
    if (video.state === VideoState.PUBLISHED) {
      // Start segment removal processing
      await queueSegmentRemovalJob(video);
    }
  }
});
```

### Option 3: Custom transcoding job

**Timing**: Replace/complement standard transcoding jobs.

**Workflow**:
```
Import → SponsorBlock cleanup job → Standard transcoding job → Video available
```

**Advantages**:
- Native integration into the transcoding pipeline
- No re-processing
- Resource savings

**Disadvantages**:
- Requires access to PeerTube internals (job queue)
- Risk of breaking changes on updates
- High complexity

**Feasibility**: To be explored — can plugins create custom jobs?

---

## FFmpeg Implementation

### Segment Cutting and Concatenation

To remove sponsor segments, we need to:
1. Cut the video into segments (parts to keep)
2. Concatenate these segments

#### Method 1: Filter complex (without re-encoding if possible)

```bash
ffmpeg -i input.mp4 \
  -filter_complex "\
    [0:v]trim=start=0:end=30,setpts=PTS-STARTPTS[v0]; \
    [0:a]atrim=start=0:end=30,asetpts=PTS-STARTPTS[a0]; \
    [0:v]trim=start=60:end=120,setpts=PTS-STARTPTS[v1]; \
    [0:a]atrim=start=60:end=120,asetpts=PTS-STARTPTS[a1]; \
    [v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]" \
  -map "[outv]" -map "[outa]" \
  -c:v libx264 -c:a aac \
  output.mp4
```

**Advantages**:
- Single FFmpeg pass
- Audio/video sync preserved

**Disadvantages**:
- **Re-encoding required** (quality loss, CPU time)
- `trim` and `concat` filters do not support stream copy

#### Method 2: Cut + concatenation with copy codec (no re-encoding)

**Step 1**: Cut the segments to keep
```bash
# Segment 1: 0s - 30s
ffmpeg -i input.mp4 -ss 0 -to 30 -c copy segment1.mp4

# Segment 2: 60s - 120s (after a 30s-60s sponsor)
ffmpeg -i input.mp4 -ss 60 -to 120 -c copy segment2.mp4
```

**Step 2**: Create a concat file
```
# concat.txt
file 'segment1.mp4'
file 'segment2.mp4'
```

**Step 3**: Concatenate
```bash
ffmpeg -f concat -safe 0 -i concat.txt -c copy output.mp4
```

**Advantages**:
- No re-encoding (very fast)
- No quality loss
- Minimal CPU usage

**Disadvantages**:
- Requires cuts at exact **keyframes**
- May have A/V sync issues if cuts are imprecise
- Temporary files (segments)

**Hybrid solution**: Cut at nearest keyframes + re-encode only transitions

#### Method 3: Re-multiplexing with segment removal (experimental)

Using `ffmpeg` with `select` filter for frames:

```bash
ffmpeg -i input.mp4 \
  -vf "select='not(between(t,30,60))',setpts=N/FRAME_RATE/TB" \
  -af "aselect='not(between(t,30,60))',asetpts=N/SR/TB" \
  -c:v libx264 -c:a aac \
  output.mp4
```

**Advantages**:
- Single pass
- Frame-by-frame precision

**Disadvantages**:
- **Re-encoding required**
- Complex to generate for multiple segments

### FFmpeg Filter Generation Code

```javascript
/**
 * Build an FFmpeg command to remove segments from a video
 * @param {string} inputPath - Input file path
 * @param {Array} segments - Segments to remove [{start: 30, end: 60}, ...]
 * @param {number} duration - Total video duration in seconds
 * @param {string} outputPath - Output file path
 * @returns {Array} FFmpeg arguments
 */
function buildFFmpegRemovalCommand(inputPath, segments, duration, outputPath) {
  // Sort segments chronologically
  const sortedSegments = segments
    .sort((a, b) => a.start - b.start);

  // Compute segments to KEEP (inversion)
  const keepSegments = [];
  let lastEnd = 0;

  for (const segment of sortedSegments) {
    if (segment.start > lastEnd) {
      keepSegments.push({
        start: lastEnd,
        end: segment.start
      });
    }
    lastEnd = Math.max(lastEnd, segment.end);
  }

  // Add the last segment to the end
  if (lastEnd < duration) {
    keepSegments.push({
      start: lastEnd,
      end: duration
    });
  }

  // If no segments to keep, error
  if (keepSegments.length === 0) {
    throw new Error('No segments to keep - video would be empty');
  }

  // Method 1: Cut + concat (no re-encoding)
  return buildSegmentedApproach(inputPath, keepSegments, outputPath);
}

/**
 * Cut + concatenation approach (no re-encoding)
 */
function buildSegmentedApproach(inputPath, keepSegments, outputPath) {
  const segmentFiles = [];
  const commands = [];

  // Step 1: Cut each segment
  keepSegments.forEach((seg, index) => {
    const segmentPath = `/tmp/segment_${index}.mp4`;
    segmentFiles.push(segmentPath);

    commands.push({
      args: [
        '-i', inputPath,
        '-ss', seg.start.toString(),
        '-to', seg.end.toString(),
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        segmentPath
      ],
      description: `Extract segment ${index}: ${seg.start}s - ${seg.end}s`
    });
  });

  // Step 2: Create the concat file
  const concatFilePath = '/tmp/concat_list.txt';
  const concatContent = segmentFiles
    .map(f => `file '${f}'`)
    .join('\n');

  // Step 3: Concatenate
  commands.push({
    args: [
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFilePath,
      '-c', 'copy',
      outputPath
    ],
    description: 'Concatenate segments',
    concatFile: {
      path: concatFilePath,
      content: concatContent
    },
    cleanup: segmentFiles
  });

  return commands;
}

/**
 * Filter complex approach (with re-encoding)
 * Use if the no-re-encoding method fails
 */
function buildFilterComplexApproach(inputPath, keepSegments, outputPath) {
  const filters = [];

  // Create trim filters for each segment
  keepSegments.forEach((seg, index) => {
    filters.push(
      `[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${index}]`,
      `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${index}]`
    );
  });

  // Build concatenation
  const vInputs = keepSegments.map((_, i) => `[v${i}]`).join('');
  const aInputs = keepSegments.map((_, i) => `[a${i}]`).join('');

  filters.push(
    `${vInputs}concat=n=${keepSegments.length}:v=1:a=0[outv]`,
    `${aInputs}concat=n=${keepSegments.length}:v=0:a=1[outa]`
  );

  const filterComplex = filters.join(';');

  return [{
    args: [
      '-i', inputPath,
      '-filter_complex', filterComplex,
      '-map', '[outv]',
      '-map', '[outa]',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      outputPath
    ],
    description: 'Process with filter_complex (re-encoding)'
  }];
}
```

### Multi-Resolution Handling

Each video has multiple files (different resolutions). **All** need processing:

```javascript
async function processAllVideoFiles(videoUuid, segments) {
  const video = await peertubeHelpers.videos.loadByUrl(videoUuid);

  // Get all video files
  const videoFiles = await getVideoFiles(video);

  // Process each resolution
  for (const file of videoFiles) {
    const inputPath = file.path;
    const outputPath = `${inputPath}.processed`;

    // Generate the FFmpeg command
    const commands = buildFFmpegRemovalCommand(
      inputPath,
      segments,
      video.duration,
      outputPath
    );

    // Execute FFmpeg
    await executeFFmpegCommands(commands);

    // Replace original file
    await replaceFile(inputPath, outputPath);
  }

  // Update video duration
  const newDuration = calculateNewDuration(video.duration, segments);
  await updateVideoDuration(video, newDuration);
}
```

### HLS Playlist Handling

HLS playlists are composed of **multiple segments** `.ts` or `.m4s`:

```
playlist.m3u8
segment-0.ts
segment-1.ts
segment-2.ts
...
```

**Problem**: Removing sponsor segments from an HLS playlist is **very complex**:
- Segments have fixed durations (e.g., 2s, 4s, 6s)
- All segment timestamps need recalculation
- The `.m3u8` file must be modified

**Recommended solution**:
1. **Option A**: Process only `web-videos` (not HLS)
2. **Option B**: Force a full HLS re-transcode after modification
3. **Option C**: Disable HLS for processed videos

---

## Job Management

### Queue Architecture

```javascript
// Table to track processing jobs
CREATE TABLE IF NOT EXISTS plugin_sponsorblock_processing_queue (
  id SERIAL PRIMARY KEY,
  video_uuid UUID NOT NULL REFERENCES video(uuid) ON DELETE CASCADE,
  youtube_id VARCHAR(11) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  -- pending, processing, completed, failed, cancelled
  priority INTEGER DEFAULT 0,
  segments JSONB NOT NULL,
  error TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP
);

CREATE INDEX idx_queue_status ON plugin_sponsorblock_processing_queue(status, priority, created_at);
```

### Processing Worker

```javascript
let isProcessing = false;

async function startWorker(peertubeHelpers) {
  if (isProcessing) return;

  const interval = setInterval(async () => {
    try {
      await processNextJob(peertubeHelpers);
    } catch (error) {
      peertubeHelpers.logger.error('Worker error', error);
    }
  }, 5000); // Every 5 seconds

  // Cleanup on plugin unload
  peertubeHelpers.onUnload(() => {
    clearInterval(interval);
  });
}

async function processNextJob(peertubeHelpers) {
  const database = peertubeHelpers.database;

  // Optimistic locking with FOR UPDATE SKIP LOCKED
  const [jobs] = await database.query(`
    UPDATE plugin_sponsorblock_processing_queue
    SET status = 'processing', started_at = NOW()
    WHERE id = (
      SELECT id FROM plugin_sponsorblock_processing_queue
      WHERE status = 'pending'
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  if (!jobs || jobs.length === 0) {
    return; // No pending jobs
  }

  const job = jobs[0];
  isProcessing = true;

  try {
    // Process the video
    await processVideoRemoveSegments(
      job.video_uuid,
      job.segments,
      peertubeHelpers
    );

    // Mark as completed
    await database.query(`
      UPDATE plugin_sponsorblock_processing_queue
      SET status = 'completed', completed_at = NOW()
      WHERE id = $1
    `, [job.id]);

    peertubeHelpers.logger.info(
      `Successfully processed video ${job.video_uuid}`
    );

  } catch (error) {
    peertubeHelpers.logger.error(
      `Failed to process video ${job.video_uuid}`,
      error
    );

    // Retry logic
    const shouldRetry = job.retry_count < job.max_retries;

    if (shouldRetry) {
      await database.query(`
        UPDATE plugin_sponsorblock_processing_queue
        SET status = 'pending',
            retry_count = retry_count + 1,
            error = $1
        WHERE id = $2
      `, [error.message, job.id]);
    } else {
      await database.query(`
        UPDATE plugin_sponsorblock_processing_queue
        SET status = 'failed',
            completed_at = NOW(),
            error = $1
        WHERE id = $2
      `, [error.message, job.id]);
    }
  } finally {
    isProcessing = false;
  }
}
```

### Job Prioritization

- **High priority**: Recent videos (< 24h)
- **Normal priority**: Older videos
- **Low priority**: Re-processing (segment updates)

```javascript
async function queueVideoProcessing(videoUuid, youtubeId, segments, priority = 0) {
  await database.query(`
    INSERT INTO plugin_sponsorblock_processing_queue
    (video_uuid, youtube_id, segments, priority)
    VALUES ($1, $2, $3, $4)
  `, [videoUuid, youtubeId, JSON.stringify(segments), priority]);
}
```

---

## Challenges and Risks

### 1. Filesystem Access

**Problem**: Do plugins have direct access to video files?

**Investigation needed**:
- Test if `peertubeHelpers` exposes file paths
- Verify permissions (can the plugin process read/write?)
- Check if PeerTube sandboxes plugins

**Potential workaround**:
- Use PeerTube's internal API to load videos
- Force a re-transcode via the API rather than direct processing

### 2. Atomicity and Consistency

**Problem**: What happens if processing fails midway?

**Risks**:
- Corrupted video file
- Partially processed video (some resolutions yes, others no)
- Inconsistent metadata (incorrect duration)

**Solutions**:
- Process to a temp file, atomic swap at the end
- Transaction on DB metadata
- Automatic backup of the original file
- Rollback on error

```javascript
async function processVideoSafe(videoPath, segments) {
  const backupPath = `${videoPath}.backup`;
  const tempPath = `${videoPath}.tmp`;

  try {
    // 1. Backup
    await fs.copyFile(videoPath, backupPath);

    // 2. Process
    await processVideo(videoPath, segments, tempPath);

    // 3. Verify
    const isValid = await verifyVideoIntegrity(tempPath);
    if (!isValid) {
      throw new Error('Processed video is corrupted');
    }

    // 4. Atomic swap
    await fs.rename(tempPath, videoPath);

    // 5. Remove backup (optional)
    await fs.unlink(backupPath);

  } catch (error) {
    // Rollback
    if (await fs.exists(backupPath)) {
      await fs.copyFile(backupPath, videoPath);
    }
    throw error;
  }
}
```

### 3. Performance and System Load

**Problem**: FFmpeg is CPU/memory-intensive.

**Impacts**:
- Server slowdown
- Queue buildup
- Job timeouts

**Solutions**:
- Limit concurrent jobs (e.g., 1 at a time)
- Nice/ionice to lower priority
- Process during off-peak hours
- Option to disable automatic processing

```javascript
// Plugin configuration
{
  "enable_auto_processing": true,
  "max_concurrent_jobs": 1,
  "processing_hours": "02:00-06:00", // Off-peak hours
  "cpu_priority": "low" // nice level
}
```

### 4. Quality Loss

**Problem**: Re-encoding can degrade quality.

**Solutions**:
- Prefer `-c copy` (no re-encoding)
- If re-encoding is needed, use high CRF (18-23)
- Keep the original file as backup

**Comparison**:
- **No re-encoding**: Fast, lossless, but cuts only at keyframes
- **With re-encoding**: Precise, but slow and potential quality loss

### 5. Remote Storage (S3)

**Problem**: Files may be on S3/MinIO, not local.

**Solutions**:
- Temporarily download locally
- Process
- Re-upload to S3
- Significant bandwidth usage

**Alternative**: Only support local storage (documented limitation).

### 6. Metadata Synchronization

**Problem**: Video duration, seeking, thumbnails.

**Impacts**:
- Displayed duration no longer matches
- Thumbnails may point to removed moments
- Comment timestamps are shifted

**Solutions**:
- Recalculate total duration
- Regenerate thumbnails
- Impossible to correct existing comment timestamps

### 7. Shifted Content

**Problem**: If a user comments "at 5:23", but 2min were removed before, the timestamp is wrong.

**Solution**: Document this limitation — it's an accepted trade-off.

---

## Recommendations

### Recommended Approach

**Phase 1**: Implement the **client-side skip** approach (RESEARCH.md — Approach 1)
- Quick to develop
- No risk
- Validates the concept

**Phase 2**: Add **optional** permanent removal
- Option in plugin settings
- Default: disabled
- Clear warning about risks

**Phase 3**: Refine based on feedback
- FFmpeg optimizations
- Remote storage support
- Monitoring interface

### Suggested Configuration

```json
{
  "mode": "skip",  // "skip" | "remove" | "hybrid"
  "remove_segments_on_import": false,
  "backup_original_files": true,
  "processing_priority": "low",
  "max_concurrent_jobs": 1,
  "require_confirmation": true,
  "categories_to_remove": ["sponsor", "selfpromo"],
  "minimum_segment_duration": 5,  // Only remove if > 5s
  "ffmpeg_method": "auto"  // "copy" | "reencode" | "auto"
}
```

### Essential Tests Before Production

1. **Test video**: Create a video with known segments
2. **Rollback test**: Simulate an error, verify restoration
3. **Performance test**: Measure CPU/memory/time
4. **Multi-resolution test**: Verify all versions are consistent
5. **Playback test**: Ensure the video plays correctly after processing

### User Documentation

Clearly inform administrators:

```markdown
**Permanent Removal Mode**

This mode modifies the original video files to permanently remove
sponsor segments.

**Advantages**:
- Storage and bandwidth savings
- Optimal experience for all clients

**Risks**:
- Irreversible modification (unless backup enabled)
- Significant CPU load
- Comment timestamps shifted
- May cause issues on error

**Recommendations**:
- Enable automatic backups
- Test on a few videos first
- Monitor logs and system load
- Have a recovery plan

For most use cases, "skip" mode (client-side skip) is sufficient.
```

---

## Additional Resources

### PeerTube Documentation

- [Architecture | PeerTube](https://docs.joinpeertube.org/contribute/architecture)
- [CLI tools guide](https://docs.joinpeertube.org/maintain/tools)
- [Configuration](https://docs.joinpeertube.org/admin/configuration)
- [Remote storage (S3)](https://docs.joinpeertube.org/maintain/remote-storage)

### FFmpeg

- [FFmpeg trim filter](https://ffmpeg.org/ffmpeg-filters.html#trim)
- [FFmpeg concat demuxer](https://ffmpeg.org/ffmpeg-formats.html#concat-1)
- [FFmpeg concat filter](https://ffmpeg.org/ffmpeg-filters.html#concat)

### Articles

- [An Admin's Guide to Fixing PeerTube](https://wedistribute.org/2024/07/fixing-peertube-videos/)
- [PeerTube 3.1 Release](https://linuxreviews.org/PeerTube_3.1_Is_Released_With_Advanced_Transcoding_Options_And_A_More_Polished_User-Interface)

---

## Conclusion

Permanent removal of sponsor segments is **technically feasible** but presents **significant challenges**:

**Feasible**:
- Database access
- FFmpeg execution
- Async job management
- Hooks to intercept imports

**Challenges**:
- File access (to be confirmed)
- Performance (CPU load)
- Corruption risks
- Remote storage handling

**Recommendation**: Start with the skip approach (client-side), then add permanent removal as an **optional, advanced feature** with appropriate warnings.
