# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-01-31

### Fixed
- **Video import hook**: use `params.video` instead of `videoImport.video` (PeerTube uses uppercase `Video` in Sequelize)
- **Category settings ignored**: settings were registered but never read; segments endpoint now filters by enabled categories
- **SponsorBlock API only returning sponsors**: all API calls now include `categories` parameter to fetch all segment types
- **Admin dashboard not rendering**: no longer depends on `html`-type setting; injects its own container into the settings page
- **Orphaned data on video deletion**: added `action:api.video.deleted` hook to clean up mappings, segments, and queue entries

### Changed
- **Process button works in any mode**: the worker always processes the queue; manual Process bypasses the mode setting
- **Mode description updated**: skip mode is default, remove mode auto-queues on import; Process button always available
- Video column in admin table shows video title with link instead of truncated UUID
- Admin buttons have tooltip descriptions (hover to see what they do)
- Dashboard appears below the settings form (after "Update plugin settings" button)

### Added
- **FFmpeg segment removal** (`server/ffmpeg.js`): hard removal of sponsor segments from video files using `ffmpeg -c copy` (no re-encoding)
- **Background worker** in `main.js`: 30s polling, supports retries (3 max) with `FOR UPDATE SKIP LOCKED`
- **`POST /process/:videoUuid`** and **`POST /process-all`** routes
- **`storage_path` setting**: configurable PeerTube storage directory
- Admin dashboard with stats, mappings table, and action buttons
- Periodic sync with configurable interval
- Scan Imports for existing YouTube videos

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

[0.4.0]: https://github.com/jblemee/peertube-plugin-sponsorblock/compare/v0.1.0...v0.4.0
[0.1.0]: https://github.com/jblemee/peertube-plugin-sponsorblock/releases/tag/v0.1.0
