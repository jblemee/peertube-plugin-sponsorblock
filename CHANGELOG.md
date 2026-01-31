# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- Permanent segment removal (FFmpeg processing)
- Admin interface for managing mappings
- Periodic sync with SponsorBlock
- Migration tool for existing videos
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

[Unreleased]: https://github.com/jblemee/peertube-plugin-sponsorblock/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jblemee/peertube-plugin-sponsorblock/releases/tag/v0.1.0
