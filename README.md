# PeerTube Plugin SponsorBlock

PeerTube plugin to integrate SponsorBlock and automatically skip (or permanently remove) sponsor segments from videos imported from YouTube.

## Goal

Allow PeerTube instances to leverage the crowdsourced SponsorBlock database to improve the viewing experience of videos imported from YouTube.

## Project Status

**Under active development**

Phase 1 (client-side skip), Phase 2 (admin dashboard & periodic sync), and Phase 3 (permanent removal) are implemented.

See the [User Guide](https://git.ut0pia.org/jbl/peertube-plugin-sponsorblock/src/branch/develop/USER_GUIDE.md) for installation and usage instructions.

## Features

### Phase 1: MVP (Client-side skip)
- Automatic YouTube ID detection on import
- SponsorBlock segment retrieval via API
- Automatic segment skipping in the video player
- Local segment caching
- Per-category configuration (sponsor, intro, outro, etc.)

### Phase 2: Admin dashboard & sync
- Admin dashboard with statistics and mappings table
- Periodic sync with SponsorBlock (configurable interval)
- Manual "Scan Imports" to map existing videos
- Per-row Sync / Process / Delete actions
- Color-coded category markers on the progress bar

### Phase 3: Permanent removal
- Background processing worker (30s polling)
- Priority queue with retries
- FFmpeg cutting (`-c copy`) and concatenation
- Support for web-videos, HLS, and original files
- API routes: single and bulk processing
- Automatic processing on import (in `remove` mode)
- Configurable `storage_path` setting

## Architecture

### Main components

1. **YouTube-to-PeerTube mapping table**
   ```sql
   plugin_sponsorblock_mapping (peertube_uuid, youtube_id)
   ```

2. **SponsorBlock segments cache**
   ```sql
   plugin_sponsorblock_segments (youtube_id, start_time, end_time, category)
   ```

3. **FFmpeg processing queue**
   ```sql
   plugin_sponsorblock_processing_queue (video_uuid, segments, status, priority)
   ```

4. **Import hooks**
   - Captures the YouTube ID on import
   - Automatic segment retrieval
   - Automatic queue insertion in `remove` mode

5. **Processing worker**
   - 30s polling (active only in `remove` mode)
   - Optimistic locking (`FOR UPDATE SKIP LOCKED`)
   - Automatic retry (3 attempts max)

6. **Video player integration**
   - Automatic segment skipping during playback
   - Visual notifications

7. **Admin dashboard**
   - Stats cards (mapped videos, segments, time saved, queue pending)
   - Mappings table with per-row actions
   - Bulk actions (Scan Imports, Sync All, Process All)
   - Periodic sync timer (configurable)

## Documentation

- [User Guide](https://git.ut0pia.org/jbl/peertube-plugin-sponsorblock/src/branch/develop/USER_GUIDE.md) — Installation, configuration, and usage guide for instance administrators
- [Development Guide](https://git.ut0pia.org/jbl/peertube-plugin-sponsorblock/src/branch/develop/DEVELOPMENT.md) — Development setup, project structure, testing, and contributing
- [Changelog](https://git.ut0pia.org/jbl/peertube-plugin-sponsorblock/src/branch/develop/CHANGELOG.md) — Version history and release notes
- [TODO](https://git.ut0pia.org/jbl/peertube-plugin-sponsorblock/src/branch/develop/TODO.md) — Roadmap, planned features, and known issues
- [Research](https://git.ut0pia.org/jbl/peertube-plugin-sponsorblock/src/branch/develop/RESEARCH.md) — State-of-the-art research and PeerTube plugin capabilities
- [Technical Analysis](https://git.ut0pia.org/jbl/peertube-plugin-sponsorblock/src/branch/develop/TECHNICAL_ANALYSIS.md) — Technical analysis of permanent segment removal with FFmpeg

## Research highlights

### State of the art

**No native SponsorBlock plugin for PeerTube currently exists.**

Similar projects:
- **peertube-plugin-chapters**: Manual chapters (not crowdsourced)
- **Tubular**: Android app with SponsorBlock + PeerTube support

Open feature requests since 2020:
- [ajayyy/SponsorBlock#1209](https://github.com/ajayyy/SponsorBlock/issues/1209)
- [ajayyy/SponsorBlock#1938](https://github.com/ajayyy/SponsorBlock/issues/1938)
- [ajayyy/SponsorBlock#993](https://github.com/ajayyy/SponsorBlock/issues/993)

### PeerTube capabilities

The PeerTube plugin system supports:
- Import hooks (`filter:api.video.post-import-url.accept.result`)
- Video player hooks (`action:video-watch.video.loaded`)
- Database access (custom table creation)
- External HTTP requests (SponsorBlock API)
- UI modification

## Technologies

- **PeerTube**: Decentralized video platform
- **SponsorBlock API**: https://sponsor.ajay.app/api/
- **FFmpeg/ffprobe**: For permanent segment removal
- **PostgreSQL**: PeerTube database
- **Node.js**: Plugin runtime

## Resources

### PeerTube documentation
- [Plugin Guide](https://docs.joinpeertube.org/contribute/plugins)
- [Plugin API](https://docs.joinpeertube.org/api/plugins)
- [Architecture](https://docs.joinpeertube.org/contribute/architecture)

### SponsorBlock
- [API Documentation](https://wiki.sponsor.ajay.app/w/API_Docs)
- [Source Code](https://github.com/ajayyy/SponsorBlock)

## Contributing

Contributions are welcome:
- PeerTube experience and feedback
- FFmpeg expertise
- Testing on development PeerTube instances

## License

AGPL-3.0 (for compatibility with PeerTube)

## Warnings

### "Skip" mode (Phase 1)
- Segments are still downloaded (no bandwidth savings)
- Works only in the PeerTube web player

### "Permanent removal" mode
- Irreversible modification of video files
- Uses `ffmpeg -c copy` (remuxing without re-encoding, fast and lossless)
- Comment timestamps will be shifted after removal
- Automatic retry (3 attempts) on error
- **Recommended only with automatic backups**
- Requires `ffmpeg` and `ffprobe` in the `PATH`

---

**Author**: Jean-Baptiste L.
**Created**: 2026-01-31
