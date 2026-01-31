# Research: SponsorBlock Plugin for PeerTube

**Research date**: 2026-01-31
**Goal**: Create a PeerTube plugin that integrates SponsorBlock to automatically skip (or remove) sponsor segments from videos imported from YouTube.

---

## Table of Contents

1. [Context](#context)
2. [State of the Art](#state-of-the-art)
3. [PeerTube Plugin System Capabilities](#peertube-plugin-system-capabilities)
4. [Proposed Architecture](#proposed-architecture)
5. [Technical Challenges](#technical-challenges)
6. [Possible Approaches](#possible-approaches)
7. [Resources](#resources)

---

## Context

### What is SponsorBlock?

SponsorBlock is a **crowdsourced** system that allows automatic skipping of sponsor segments in YouTube videos. Users manually submit timestamps of unwanted segments:
- Sponsorships (product placements)
- Intros/outros
- Subscription reminders
- Self-promotions
- Non-music segments in music videos

This data is stored in a centralized database accessible via API: `https://sponsor.ajay.app/api/`

### The Problem

PeerTube does not natively support SponsorBlock. Videos imported from YouTube still contain sponsor segments, even though SponsorBlock has already identified these segments in its database.

### Specific Use Case

Videos are imported into PeerTube:
- Either manually via YouTube URL
- Or automatically via YouTube channel synchronization

In these cases, **the original YouTube ID is known** and can be used to query the SponsorBlock API.

---

## State of the Art

### Existing Projects

#### 1. **peertube-plugin-chapters**
- **URL**: https://github.com/samlich/peertube-plugin-chapters
- **NPM**: https://www.npmjs.com/package/peertube-plugin-chapters
- **Status**: Last published 3 years ago (v1.1.3)
- **Feature**: Allows manually adding chapters to videos with tags similar to SponsorBlock ("Sponsor", "Self-promotion", etc.)
- **Limitation**:
  - **Manual** input only
  - No connection to the SponsorBlock database
  - Was supposed to become obsolete per the PeerTube 2023 roadmap

#### 2. **Tubular (Android)**
- **URL**: https://alternativeto.net/software/newpipe-x-sponsorblock/about/
- **Feature**: Android client combining SponsorBlock and PeerTube support
- **Limitation**: Mobile app, not a server plugin

### Open Feature Requests

Several requests since **2020** remain unimplemented:
- [Issue #1209](https://github.com/ajayyy/SponsorBlock/issues/1209) — Add PeerTube support (2022)
- [Issue #1938](https://github.com/ajayyy/SponsorBlock/issues/1938) — Lack of PeerTube Support
- [Issue #993](https://github.com/ajayyy/SponsorBlock/issues/993) — PeerTube Support (2020)
- [Issue #515](https://github.com/ajayyy/SponsorBlock/issues/515) — Expand integration beyond YouTube

### Conclusion

**No native SponsorBlock plugin for PeerTube currently exists.**

---

## PeerTube Plugin System Capabilities

### Official Documentation

- **Plugin Guide**: https://docs.joinpeertube.org/contribute/plugins
- **API Reference**: https://docs.joinpeertube.org/api/plugins
- **Embed API**: https://docs.joinpeertube.org/api/embed-player

### Hook System

PeerTube uses a hook system with 3 types:
1. **Filter hooks**: Modify parameters or return values
2. **Action hooks**: Execute code after an event
3. **Static hooks**: Like action hooks but PeerTube waits for their execution

### Hooks Relevant to SponsorBlock

#### Video Import Hooks

```javascript
// Before import
'filter:api.video.pre-import-url.accept.result'
'filter:api.video.pre-import-torrent.accept.result'

// After import
'filter:api.video.post-import-url.accept.result'
'filter:api.video.post-import-torrent.accept.result'

// Attribute modification during import
'filter:api.video.import-url.video-attribute.result'
'filter:api.video.import-torrent.video-attribute.result'

// User import (PeerTube >= 6.1)
'filter:api.video.user-import.accept.result'
'filter:api.video.user-import.video-attribute.result'
```

#### Video Player Hooks

```javascript
// Video loaded in the player
'action:video-watch.video.loaded'

// Playback events
'action:api.video.uploaded'
'action:api.video.updated'
```

### Database Access

Plugins can access the PostgreSQL database via `peertubeHelpers.database`:

```javascript
async function register ({ peertubeHelpers }) {
  const database = peertubeHelpers.database;

  // Execute raw SQL queries
  const [results, _] = await database.query(`
    SELECT "videoId" as id, name FROM video WHERE ...
  `);

  // Create custom tables
  await database.query(`
    CREATE TABLE IF NOT EXISTS plugin_my_table (
      id SERIAL PRIMARY KEY,
      data JSONB
    );
  `);
}
```

### Data Storage

Two options:
1. **PluginStorageManager**: JSON key-value storage in the PeerTube DB
2. **Custom tables**: Via direct SQL queries

### External API Access

Plugins can make external HTTP requests to query APIs like SponsorBlock.

### UI Modification

- CSS and static file injection
- Video player and controls modification
- Custom routes and pages

---

## Proposed Architecture

### Plugin Components

#### 1. YouTube ID to PeerTube UUID Mapping Table

```sql
CREATE TABLE IF NOT EXISTS plugin_sponsorblock_mapping (
  peertube_uuid UUID PRIMARY KEY REFERENCES video(uuid) ON DELETE CASCADE,
  youtube_id VARCHAR(11) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  last_sync TIMESTAMP
);

CREATE INDEX idx_youtube_id ON plugin_sponsorblock_mapping(youtube_id);
```

#### 2. Local SponsorBlock Segments Cache

```sql
CREATE TABLE IF NOT EXISTS plugin_sponsorblock_segments (
  id SERIAL PRIMARY KEY,
  youtube_id VARCHAR(11) NOT NULL,
  segment_uuid UUID NOT NULL,
  start_time FLOAT NOT NULL,
  end_time FLOAT NOT NULL,
  category VARCHAR(50) NOT NULL,
  action_type VARCHAR(20) NOT NULL,
  votes INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_segments_youtube_id ON plugin_sponsorblock_segments(youtube_id);
```

#### 3. Import Hook to Capture YouTube ID

```javascript
registerHook({
  target: 'filter:api.video.post-import-url.accept.result',
  handler: async (result, params) => {
    const { videoImport } = params;
    const targetUrl = videoImport.targetUrl;

    // Extract YouTube ID
    const youtubeId = extractYouTubeId(targetUrl);

    if (youtubeId && videoImport.video) {
      // Save mapping
      await database.query(`
        INSERT INTO plugin_sponsorblock_mapping (peertube_uuid, youtube_id)
        VALUES ($1, $2)
        ON CONFLICT (peertube_uuid) DO NOTHING
      `, [videoImport.video.uuid, youtubeId]);

      // Fetch and cache SponsorBlock segments
      await fetchAndCacheSegments(youtubeId);
    }

    return result;
  }
});
```

#### 4. YouTube ID Extraction Function

```javascript
function extractYouTubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}
```

#### 5. SponsorBlock Segment Retrieval

```javascript
async function fetchAndCacheSegments(youtubeId) {
  try {
    const response = await fetch(
      `https://sponsor.ajay.app/api/skipSegments?videoID=${youtubeId}`
    );

    if (!response.ok) return;

    const segments = await response.json();

    for (const segment of segments) {
      await database.query(`
        INSERT INTO plugin_sponsorblock_segments
        (youtube_id, segment_uuid, start_time, end_time, category, action_type, votes)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT DO NOTHING
      `, [
        youtubeId,
        segment.UUID,
        segment.segment[0],
        segment.segment[1],
        segment.category,
        segment.actionType,
        segment.votes
      ]);
    }
  } catch (error) {
    peertubeHelpers.logger.error('Failed to fetch SponsorBlock segments', error);
  }
}
```

---

## Technical Challenges

### 1. Video Identification

**Problem**: PeerTube does not natively store the source YouTube URL/ID.

**Solutions**:
- Open feature requests (#2467, #6013) but not implemented
- The plugin can create its own mapping table
- ID extraction on import via hooks

### 2. Already Imported Videos

**Problem**: Videos imported before the plugin is installed will not have a mapping.

**Solutions**:
- Migration script to analyze descriptions/metadata
- Admin interface to manually link videos
- Use the YouTube API to search by title/description

### 3. SponsorBlock Synchronization

**Problem**: SponsorBlock segments evolve (new segments, modified votes).

**Solutions**:
- Periodic cron task for re-sync
- Webhook if the SponsorBlock API supports it
- Cache with TTL (Time To Live)

### 4. Core Schema Modifications

**Problem**: Modifying PeerTube core tables can cause conflicts with official migrations.

**Solution**:
- Use only custom tables with the `plugin_*` prefix
- Foreign keys with `ON DELETE CASCADE` for consistency

---

## Possible Approaches

### Approach 1: Client-side skip (video player)

**Description**: Like SponsorBlock on YouTube, automatically skip segments during playback.

**Implementation**:
```javascript
registerHook({
  target: 'action:video-watch.video.loaded',
  handler: async ({ video, player }) => {
    // Fetch YouTube ID
    const [rows] = await database.query(`
      SELECT youtube_id FROM plugin_sponsorblock_mapping
      WHERE peertube_uuid = $1
    `, [video.uuid]);

    if (!rows[0]) return;

    // Fetch segments
    const [segments] = await database.query(`
      SELECT start_time, end_time, category
      FROM plugin_sponsorblock_segments
      WHERE youtube_id = $1
    `, [rows[0].youtube_id]);

    // Implement automatic skipping
    player.on('timeupdate', () => {
      const currentTime = player.currentTime();

      for (const segment of segments) {
        if (currentTime >= segment.start_time &&
            currentTime < segment.end_time) {
          player.currentTime(segment.end_time);

          // Show a notification
          showNotification(`Skipped ${segment.category} segment`);
          break;
        }
      }
    });
  }
});
```

**Advantages**:
- No modification of video files
- Reversible (can be disabled)
- Quick to implement
- No additional storage

**Disadvantages**:
- Segments are still downloaded (bandwidth)
- Works only in the PeerTube web player
- Can be bypassed by downloading the video

---

### Approach 2: Permanent segment removal (video post-processing)

**Description**: Modify the source video file to physically remove sponsor segments.

**Implementation**:

#### Step 1: Post-import hook

```javascript
registerHook({
  target: 'filter:api.video.post-import-url.accept.result',
  handler: async (result, params) => {
    const { videoImport } = params;
    const youtubeId = extractYouTubeId(videoImport.targetUrl);

    if (youtubeId && videoImport.video) {
      // Save mapping
      await saveMapping(videoImport.video.uuid, youtubeId);

      // Fetch segments
      const segments = await fetchSponsorBlockSegments(youtubeId);

      if (segments.length > 0) {
        // Queue video processing in background
        await queueVideoProcessing(videoImport.video.uuid, segments);
      }
    }

    return result;
  }
});
```

#### Step 2: Video processing with FFmpeg

```javascript
async function processVideoRemoveSegments(videoUuid, segments) {
  const video = await peertubeHelpers.videos.loadByUrl(videoUuid);
  const videoPath = getVideoFilePath(video);
  const outputPath = getTempPath();

  // Sort segments chronologically
  segments.sort((a, b) => a.start_time - b.start_time);

  // Create an FFmpeg cutting filter
  const filterComplex = buildFFmpegFilterComplex(segments, video.duration);

  // Execute FFmpeg
  await execFFmpeg([
    '-i', videoPath,
    '-filter_complex', filterComplex,
    '-c:v', 'copy',  // Copy without re-encoding if possible
    '-c:a', 'copy',
    outputPath
  ]);

  // Replace original file
  await replaceVideoFile(video, outputPath);

  // Update video duration
  await updateVideoDuration(video);
}
```

#### Step 3: FFmpeg filter construction

```javascript
function buildFFmpegFilterComplex(segments, duration) {
  // Create a list of parts to keep (invert the segments to remove)
  const keepSegments = [];
  let lastEnd = 0;

  for (const segment of segments) {
    if (segment.start_time > lastEnd) {
      keepSegments.push({
        start: lastEnd,
        end: segment.start_time
      });
    }
    lastEnd = segment.end_time;
  }

  // Add the last part
  if (lastEnd < duration) {
    keepSegments.push({
      start: lastEnd,
      end: duration
    });
  }

  // Build the FFmpeg concat filter
  const filters = [];

  for (let i = 0; i < keepSegments.length; i++) {
    const seg = keepSegments[i];
    filters.push(
      `[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`,
      `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`
    );
  }

  // Concatenate all segments
  const vInputs = keepSegments.map((_, i) => `[v${i}]`).join('');
  const aInputs = keepSegments.map((_, i) => `[a${i}]`).join('');

  filters.push(
    `${vInputs}concat=n=${keepSegments.length}:v=1:a=0[outv]`,
    `${aInputs}concat=n=${keepSegments.length}:v=0:a=1[outa]`
  );

  return filters.join(';');
}
```

#### Step 4: Queue management

```javascript
// Table to track processing jobs
CREATE TABLE IF NOT EXISTS plugin_sponsorblock_processing_queue (
  id SERIAL PRIMARY KEY,
  video_uuid UUID NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',  -- pending, processing, completed, failed
  segments JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  error TEXT
);

// Processing worker
async function processQueue() {
  const [job] = await database.query(`
    UPDATE plugin_sponsorblock_processing_queue
    SET status = 'processing', started_at = NOW()
    WHERE id = (
      SELECT id FROM plugin_sponsorblock_processing_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  if (!job[0]) return;

  try {
    await processVideoRemoveSegments(job[0].video_uuid, job[0].segments);

    await database.query(`
      UPDATE plugin_sponsorblock_processing_queue
      SET status = 'completed', completed_at = NOW()
      WHERE id = $1
    `, [job[0].id]);
  } catch (error) {
    await database.query(`
      UPDATE plugin_sponsorblock_processing_queue
      SET status = 'failed', error = $1
      WHERE id = $2
    `, [error.message, job[0].id]);
  }
}
```

**Advantages**:
- Bandwidth savings (segments removed)
- Storage savings
- Works everywhere (downloads, external players)
- Optimal user experience

**Disadvantages**:
- Complex to implement
- Irreversible (unless backup)
- CPU/processing time (FFmpeg)
- Risk of quality loss if re-encoding is needed
- Requires access to video files on the filesystem
- May require elevated permissions

**Specific challenges**:

1. **Video file access**: Do plugins have filesystem access?
2. **Transcoding**: PeerTube stores multiple versions (different resolutions) — all need processing
3. **Synchronization**: Managing states during processing (video temporarily unavailable?)
4. **Atomicity**: Ensuring file replacement is atomic
5. **Rollback**: What to do on error?

---

### Approach 3: Hybrid

**Description**: Combine both approaches.

**Implementation**:
1. **Immediate skip**: Use approach 1 for an immediate user experience
2. **Background processing**: Launch approach 2 in background
3. **Progressive update**: Once processing is complete, serve the cleaned version

**Advantages**:
- Best UX (no waiting)
- Benefits of both approaches over time

**Disadvantages**:
- Maximum complexity
- Managing two parallel systems

---

## Recommendations

### Phase 1: MVP (Minimum Viable Product)

**Goal**: Validate technical feasibility with approach 1 (client-side skip).

**Tasks**:
1. Create the plugin structure
2. Implement the YouTube ID mapping table
3. Import hook to capture YouTube ID
4. SponsorBlock segment retrieval and caching
5. Automatic skipping in the video player
6. Configuration interface (enable/disable by category)

### Phase 2: Improvements

**Goal**: Add advanced features.

**Tasks**:
- Admin interface for managing mappings
- Periodic sync with SponsorBlock
- Support for already imported videos (migration)
- Statistics (skipped segments, time saved)
- Visual indicators on the timeline

### Phase 3: Permanent removal (optional)

**Goal**: Implement approach 2 if needed.

**Prerequisites**:
- Verify file access permissions
- Test FFmpeg performance
- Implement a backup system
- Manage processing states

**To explore**:
- Does PeerTube have a transcoding API?
- Can we reuse the existing job system?
- How to handle WebTorrents (distributed files)?

---

## Resources

### PeerTube Documentation

- **Plugin Guide**: https://docs.joinpeertube.org/contribute/plugins
- **Plugin API**: https://docs.joinpeertube.org/api/plugins
- **Embed API**: https://docs.joinpeertube.org/api/embed-player
- **Server Development Guide**: https://docs.joinpeertube.org/support/doc/development/server
- **Architecture**: https://docs.joinpeertube.org/contribute/architecture

### Plugin Examples

- **peertube-plugin-chapters**: https://github.com/samlich/peertube-plugin-chapters
- **Plugin list**: https://framagit.org/framasoft/peertube/official-plugins

### SponsorBlock API

- **API Documentation**: https://wiki.sponsor.ajay.app/w/API_Docs
- **Source Code**: https://github.com/ajayyy/SponsorBlock
- **Main Endpoint**: `GET https://sponsor.ajay.app/api/skipSegments?videoID={videoID}`

### Tools

- **FFmpeg**: https://ffmpeg.org/documentation.html
- **Sequelize (PeerTube ORM)**: https://sequelize.org/docs/v6/

### Relevant GitHub Issues

- [#2467 — Store original import URL](https://github.com/Chocobozzz/PeerTube/issues/2467)
- [#6013 — Store import URL](https://github.com/Chocobozzz/PeerTube/issues/6013)
- [#1209 — SponsorBlock: Add PeerTube support](https://github.com/ajayyy/SponsorBlock/issues/1209)
- [#1938 — Lack of PeerTube Support](https://github.com/ajayyy/SponsorBlock/issues/1938)

---

## Next Steps

1. **Analyze the peertube-plugin-chapters source code** to understand the structure
2. **Create the plugin skeleton** with package.json and base structure
3. **Test the hooks** in a PeerTube development environment
4. **Implement the MVP** (approach 1: client-side skip)
5. **Test** on a development PeerTube instance
6. **Publish** to NPM and the PeerTube registry

---

## Notes

- **Permissions**: To be verified — whether plugins can access video files for approach 2
- **Performance**: FFmpeg can be very resource-intensive
- **Storage**: Approach 2 requires temporary space for processing
- **License**: SponsorBlock is LGPL 3.0, check compatibility
