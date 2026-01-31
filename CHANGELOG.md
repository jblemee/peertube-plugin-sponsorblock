# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **FFmpeg segment removal** (`server/ffmpeg.js`): hard removal of sponsor segments from video files using `ffmpeg -c copy` (no re-encoding)
  - `getVideoDuration()`: ffprobe-based duration detection
  - `computeKeepSegments()`: segment merging, inversion, and validation
  - `processVideoFile()`: cut, concatenate, and replace original file
  - `findVideoFiles()`: discover local web-videos, HLS, and original files via PeerTube DB
- **Background worker** in `main.js`: 30s polling, processes queue when mode is `remove`, supports retries (3 max) with `FOR UPDATE SKIP LOCKED`
- **`POST /process/:videoUuid`** route: queue a single video for FFmpeg processing (priority 5, admin auth)
- **`POST /process-all`** route: bulk-queue all mapped videos not yet processed (priority 1, admin auth)
- **`storage_path` setting**: configurable PeerTube storage directory (default `/var/www/peertube/storage`)
- **8 new translation keys** in `en.json` and `fr.json` for processing messages
- Proper `unregister()` cleanup (clears worker interval)

### Planned
- Admin interface for managing mappings
- Periodic sync with SponsorBlock
- Statistics and metrics

## [0.1.0] - 2026-01-31

### Added
- Initial plugin skeleton
- YouTube ID extraction from import URLs
- SponsorBlock API integration
- Database tables for mapping and segments caching
- Client-side automatic segment skipping
- Visual progress bar markers
- Skip notifications
- REST API for segments retrieval
- Multi-language support (EN, FR)
- Configurable categories
- Admin settings panel

### Features
- Automatic detection of YouTube videos on import
- Real-time segment skipping during playback
- Color-coded progress bar markers by category
- Manual sync endpoint for updating segments
- Comprehensive documentation

### Technical
- Server-side hooks for video import
- Client-side Video.js integration
- PostgreSQL tables for data persistence
- Express routes for API endpoints
- Settings management system

[Unreleased]: https://git.ut0pia.org/jbl/peertube-plugin-sponsorblock/compare/v0.1.0...HEAD
[0.1.0]: https://git.ut0pia.org/jbl/peertube-plugin-sponsorblock/releases/tag/v0.1.0
