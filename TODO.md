# TODO

## Phase 1: MVP (Client-side skip) — In Progress

### Completed
- [x] Project structure
- [x] Package.json with PeerTube metadata
- [x] Database tables
- [x] YouTube import hook
- [x] YouTube ID extraction
- [x] SponsorBlock API integration
- [x] Segment caching in DB
- [x] Client-side skip logic
- [x] Progress bar markers
- [x] Skip notifications
- [x] REST API for segment retrieval
- [x] Plugin settings
- [x] Translations (EN, FR)
- [x] CSS for markers
- [x] Development documentation

### To Do

#### High Priority
- [ ] Test the plugin on a real PeerTube instance
- [ ] Fix bugs identified during testing
- [ ] Add missing error handling
- [ ] Validate Video.js compatibility
- [ ] Test with different segment categories

#### Medium Priority
- [ ] Add a button to temporarily disable skipping
- [ ] Allow reporting a bad segment
- [ ] Statistics: total time saved
- [ ] Playlist support

#### Low Priority
- [ ] Unit tests
- [ ] Integration tests
- [ ] Linter (ESLint configuration)
- [ ] CI/CD (GitHub Actions)

## Phase 2: Admin Dashboard & Sync

### Admin Interface
- [x] Admin page to view all mappings
- [x] Button to force synchronization
- [x] Dashboard with statistics
- [x] Color-coded category markers on progress bar
- [ ] Search videos by YouTube ID
- [ ] Plugin activity logs

### Migration and Sync
- [x] Scan existing imports via POST /scan
- [x] Periodic sync task (configurable interval)
- [ ] Detect stale segments
- [ ] Webhook if SponsorBlock supports it
- [ ] Import/export mappings

### Advanced Features
- [ ] Channel whitelist/blacklist
- [ ] Per-user settings
- [ ] "Mute" segment support (instead of skip)
- [ ] Preview before skip (skip button)
- [ ] Skipped segment history

## Phase 3: Permanent Removal

### Feasibility Analysis
- [x] Verify video file access from a plugin
- [x] Test FFmpeg from the plugin context
- [x] Validate required permissions
- [ ] Measure performance impact on the server

### Implementation
- [x] Queue processing worker (`main.js` — 30s polling)
- [x] FFmpeg cut and concat integration (`server/ffmpeg.js` — `-c copy`)
- [x] Multi-resolution support (web-videos + HLS)
- [x] HLS playlist support
- [x] Priority queue (`plugin_sponsorblock_processing_queue`)
- [x] Automatic retry (3 attempts max, `FOR UPDATE SKIP LOCKED`)
- [x] API routes: `POST /process/:videoUuid` and `POST /process-all`
- [x] Configurable `storage_path` setting
- [x] Translation of messages (EN, FR)
- [ ] Automatic backup system
- [ ] Rollback on error
- [ ] S3 storage support

### Security and Stability
- [x] Optimistic job locking (no double processing)
- [x] Output file validation (non-empty)
- [x] Temporary directory cleanup (try/finally)
- [ ] Video integrity check (checksum)
- [ ] CPU load limiting
- [ ] Monitoring and alerts

## Known Bugs

- None so far (plugin not tested in production)

## Future Ideas

- [ ] Support for other platforms (Vimeo, Dailymotion)
- [ ] Submit new segments to SponsorBlock
- [ ] AI-generated segments locally
- [ ] Integration with other PeerTube plugins
- [ ] API for mobile clients
- [ ] Companion browser extension
- [ ] "Preview" mode: show 2s of the segment before skipping

## Open Questions

- **Performance**: Impact of skipping on mobile battery?
- **UX**: Should there be a "stop skipping this segment type" button?
- **Legal**: Copyright issues with permanent removal?
- **Technical**: Use PeerTube's Bull job system?
- **Community**: Host our own SponsorBlock server?

## Notes

- Priority: Ship a stable MVP before adding features
- Keep the code simple and maintainable
- Document all technical decisions
- Test on multiple PeerTube instances
