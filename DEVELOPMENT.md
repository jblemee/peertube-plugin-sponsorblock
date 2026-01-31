# Development Guide

This document explains how to develop and test the PeerTube SponsorBlock plugin.

## Prerequisites

- Node.js >= 16
- A development PeerTube instance (>= 6.0.0)
- PostgreSQL (used by PeerTube)
- FFmpeg and ffprobe (required for permanent removal mode)

## Development Setup

### 1. Clone the project

```bash
git clone https://github.com/jblemee/peertube-plugin-sponsorblock.git
cd peertube-plugin-sponsorblock
```

### 2. Install dependencies

```bash
npm install
```

### 3. Link the plugin to your PeerTube instance

#### Option A: Install from local directory

```bash
# From the PeerTube directory
cd /var/www/peertube

# Install the plugin
sudo -u peertube NODE_CONFIG_DIR=/var/www/peertube/config NODE_ENV=production npm run plugin:install -- --plugin-path /path/to/peertube-plugin-sponsorblock
```

#### Option B: Symlink for rapid development

```bash
# Create a symlink in the PeerTube plugins directory
ln -s /path/to/peertube-plugin-sponsorblock /var/www/peertube/storage/plugins/node_modules/peertube-plugin-sponsorblock

# Restart PeerTube
sudo systemctl restart peertube
```

### 4. Enable the plugin

1. Go to the PeerTube admin interface
2. Navigate to **Administration** > **Plugins/Themes**
3. Enable the **SponsorBlock** plugin
4. Configure the settings as needed

## Project Structure

```
peertube-plugin-sponsorblock/
├── main.js                 # Server entry point (settings, hooks, worker, sync timer)
├── package.json            # Plugin metadata
├── client/                 # Client-side code (browser)
│   ├── common.js           # Common code
│   ├── video-watch.js      # Video player (skip logic)
│   └── admin.js            # Admin dashboard (admin-plugin scope)
├── server/                 # Server-side code
│   ├── routes.js           # REST API (segments, mapping, scan, sync, process, admin)
│   └── ffmpeg.js           # FFmpeg/ffprobe wrapper (cut, concat, file discovery)
├── assets/                 # Static resources
│   ├── style.css           # CSS styles
│   └── images/             # Images
├── languages/              # Translations
│   ├── en.json             # English
│   └── fr.json             # French
└── scripts/                # Build scripts
```

## Architecture

### Data Flow

```
YouTube Import → Post-import hook → YouTube ID extraction → SponsorBlock API
                                                            ↓
                                                     Cache in DB
                                                      ↓            ↓
                               (remove mode)     (skip mode)
                               Queue processing  Client skip
                                     ↓                  ↓
                               Worker (30s)    API /segments/:uuid → Automatic skip
                                     ↓
                               FFmpeg cut + concat → File replacement
```

### Database Tables

The plugin creates 3 tables:

1. **`plugin_sponsorblock_mapping`**: YouTube ID to PeerTube UUID mapping
2. **`plugin_sponsorblock_segments`**: SponsorBlock segments cache
3. **`plugin_sponsorblock_processing_queue`**: Queue for "remove" mode

## Testing the Plugin

### 1. Import a YouTube video

```bash
# Via the web interface or CLI
cd /var/www/peertube
sudo -u peertube NODE_CONFIG_DIR=/var/www/peertube/config NODE_ENV=production npm run import-videos -- \
  --target-url "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

### 2. Verify the database mapping

```bash
sudo -u postgres psql peertube_prod

SELECT * FROM plugin_sponsorblock_mapping;
SELECT * FROM plugin_sponsorblock_segments;
```

### 3. Test skipping in the player

1. Open the imported video
2. Observe the colored markers on the progress bar
3. Let the video play: segments should be skipped automatically
4. A notification should appear on each skip

### 4. Test the API

```bash
BASE=http://localhost:9000/plugins/sponsorblock/router

# Fetch segments for a video
curl $BASE/segments/{VIDEO_UUID}

# Fetch the YouTube mapping
curl $BASE/mapping/{VIDEO_UUID}

# Force a sync
curl -X POST $BASE/sync/{VIDEO_UUID}

# Queue a video for FFmpeg processing (admin auth required)
curl -X POST $BASE/process/{VIDEO_UUID} -H "Authorization: Bearer TOKEN"

# Queue all unprocessed videos (admin auth required)
curl -X POST $BASE/process-all -H "Authorization: Bearer TOKEN"

# Get admin dashboard stats (admin auth required)
curl $BASE/admin/stats -H "Authorization: Bearer TOKEN"

# Get all mappings with details (admin auth required)
curl $BASE/admin/mappings -H "Authorization: Bearer TOKEN"

# Sync all mappings (admin auth required)
curl -X POST $BASE/sync-all -H "Authorization: Bearer TOKEN"

# Delete a mapping (admin auth required)
curl -X DELETE $BASE/mapping/{VIDEO_UUID} -H "Authorization: Bearer TOKEN"
```

### 5. Test permanent removal mode

1. Set the mode to `remove` in the plugin settings
2. Verify that `storage_path` points to the correct directory
3. Verify FFmpeg: `ffmpeg -version && ffprobe -version`
4. Import a YouTube video with known segments
5. Check the queue in the database:
   ```bash
   sudo -u postgres psql peertube_prod -c "SELECT id, video_uuid, status, priority FROM plugin_sponsorblock_processing_queue;"
   ```
6. The worker processes jobs every 30s — check the logs for progress

## Development

### Logs

Plugin logs are visible in the PeerTube logs:

```bash
# Follow logs in real time
sudo journalctl -u peertube -f

# Or from the log files
tail -f /var/www/peertube/storage/logs/peertube.log
```

### Debugging client-side code

Open the browser developer console (F12):

```javascript
// Plugin logs start with [SponsorBlock]
console.log('[SponsorBlock] Video loaded')
```

### Reloading the plugin after changes

```bash
# Restart PeerTube
sudo systemctl restart peertube

# Or reload plugins only (if available)
# Via the admin interface: Plugins > Reload
```

## Developing New Features

### Adding a new hook

Edit `main.js`:

```javascript
registerHook({
  target: 'action:api.video.updated',
  handler: async (params) => {
    // Your code here
  }
})
```

Full list of hooks: https://docs.joinpeertube.org/api/plugins

### Adding a new API route

Edit `server/routes.js`:

```javascript
router.get('/my-endpoint', async (req, res) => {
  // Your code here
  res.json({ success: true })
})
```

### Modifying client-side behavior

Edit `client/video-watch.js`:

```javascript
// Your code to interact with the video player
player.on('play', () => {
  console.log('Video started playing')
})
```

## Tests

### Unit tests (TODO)

```bash
npm test
```

### Integration tests (TODO)

```bash
npm run test:integration
```

## Publishing

### Preparing a release

1. Update the version in `package.json`
2. Update `CHANGELOG.md`
3. Create a git tag:

```bash
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

### Publishing to NPM

```bash
npm publish
```

### Submitting to the PeerTube registry

The plugin will be automatically indexed by PeerTube if published on NPM with the `peertube-plugin-` prefix.

## Resources

- **PeerTube Documentation**: https://docs.joinpeertube.org/contribute/plugins
- **SponsorBlock API**: https://wiki.sponsor.ajay.app/w/API_Docs
- **Plugin Example**: https://github.com/samlich/peertube-plugin-chapters

## Known Issues

### The plugin does not activate

- Check the logs: `sudo journalctl -u peertube -f`
- Verify that `engine.peertube` in `package.json` matches your version
- Check the plugin directory permissions

### Segments are not skipped

- Open the developer console (F12)
- Verify that segments are fetched: `[SponsorBlock] Found X segments to skip`
- Verify that the API returns segments: `/plugins/sponsorblock/router/segments/{UUID}`

### Database error

- Verify the tables exist: `\dt plugin_sponsorblock*` in psql
- Drop and recreate the tables if needed (warning: data loss)

## Support

To report a bug or request a feature:
https://github.com/jblemee/peertube-plugin-sponsorblock/issues
