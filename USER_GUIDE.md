# User Guide — PeerTube SponsorBlock Plugin

This guide covers installation, configuration, and usage of the SponsorBlock plugin for PeerTube instance administrators.

---

## 1. Installation

### From source

```bash
# Clone the repository
git clone https://github.com/jblemee/peertube-plugin-sponsorblock.git

# Install from the PeerTube directory
cd /var/www/peertube
sudo -u peertube NODE_CONFIG_DIR=/var/www/peertube/config NODE_ENV=production \
  npm run plugin:install -- --plugin-path /path/to/peertube-plugin-sponsorblock
```

### Docker

```bash
# Clone inside the container or mount the plugin directory, then:
docker exec -it <peertube_container> \
  npm run plugin:install -- --plugin-path /path/to/peertube-plugin-sponsorblock
docker restart <peertube_container>
```

### From NPM (when published)

Once the plugin is published to the npm registry, you will be able to install it directly:

```bash
cd /var/www/peertube
sudo -u peertube NODE_CONFIG_DIR=/var/www/peertube/config NODE_ENV=production \
  npm run plugin:install -- --npm-name peertube-plugin-sponsorblock
```

After installation, go to **Administration > Plugins/Themes** and verify the plugin is listed and enabled.

---

## 2. Configuration

Open **Administration > Plugins/Themes > SponsorBlock > Settings**.

### Operation Mode

| Setting | Default | Description |
|---------|---------|-------------|
| **Operation mode** | `Skip segments (client-side)` | **Skip**: segments are skipped during playback in the browser. **Remove**: segments are permanently cut from video files using FFmpeg. |

- **Skip mode** is safe and reversible. Recommended for most instances.
- **Remove mode** is irreversible. Only use with backups enabled. Requires `ffmpeg` and `ffprobe` in the system `PATH`.

### Segment Categories

Each SponsorBlock category can be individually enabled or disabled:

| Category | Default | What it skips |
|----------|---------|---------------|
| Sponsors | On | Paid product placements |
| Self-promotion | On | Plugs for the creator's own products/channels |
| Interaction reminders | On | "Like and subscribe" prompts |
| Intros | Off | Opening animations or greetings |
| Outros | Off | End-of-video credits or cards |
| Previews/Recaps | Off | Previews of upcoming or recap of previous content |
| Off-topic music | Off | Music unrelated to the video topic |
| Filler content | Off | Tangential or filler content |

### Advanced Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **SponsorBlock API URL** | `https://sponsor.ajay.app` | URL of the SponsorBlock server. Change only if using a self-hosted mirror. |
| **Cache duration (hours)** | `24` | How long cached segments are considered fresh before a re-fetch. |
| **Show skip notifications** | On | Display a toast notification when a segment is skipped. |
| **PeerTube storage path** | `/var/www/peertube/storage` | Absolute path to your PeerTube storage directory. Required for remove mode. |
| **Periodic sync interval (hours)** | `0` (disabled) | When set to a positive number, the plugin automatically re-fetches segments for all mapped videos at this interval. Set to `0` to disable. |

---

## 3. How It Works

### Automatic detection on import

When a video is imported from YouTube (via URL import or channel sync), the plugin:

1. Extracts the YouTube video ID from the import URL
2. Saves a mapping (PeerTube UUID <-> YouTube ID)
3. Fetches sponsor segments from the SponsorBlock API
4. Caches them locally in the database

No manual action is required for new imports.

### Client-side skipping (Skip mode)

When a viewer opens a video that has mapped segments:

1. The player fetches segments from the plugin API
2. Color-coded markers appear on the progress bar (each category has a distinct color)
3. When playback enters a segment, the player automatically jumps to the end of it
4. A notification briefly appears: *"Skipped Sponsor (12.5s)"*

### Permanent removal (Remove mode)

When remove mode is enabled:

1. On import, the video is additionally queued for FFmpeg processing
2. A background worker (polling every 30 seconds) picks up queued jobs
3. FFmpeg cuts the segments using `-c copy` (no re-encoding, no quality loss)
4. All video file versions (web-videos, HLS, originals) are processed
5. The original file is replaced with the cleaned version
6. Up to 3 automatic retries on failure

---

## 4. Admin Dashboard

The admin dashboard is embedded in the plugin settings page. Open **Administration > Plugins/Themes > SponsorBlock > Settings** and scroll down.

### Stats Row

Four cards display at-a-glance metrics:

- **Mapped Videos** — total number of PeerTube videos linked to a YouTube ID
- **Total Segments** — total cached SponsorBlock segments across all videos
- **Time Saved** — cumulative duration of all segments (e.g., `14m 32s`)
- **Queue Pending** — number of videos waiting for FFmpeg processing

### Action Buttons

| Button | What it does |
|--------|-------------|
| **Scan Imports** | Scans the PeerTube `videoImport` table for YouTube URLs, creates mappings for any that don't already exist, and fetches their segments. Use this after installing the plugin on an instance with existing YouTube imports. |
| **Sync All** | Re-fetches segments from SponsorBlock for every mapped video. Runs in the background with 200ms rate limiting between API calls. |
| **Process All** | Queues every mapped video that has segments but has not yet been processed for FFmpeg removal. Only relevant in remove mode. |

### Mappings Table

Each row shows one mapped video:

| Column | Description |
|--------|-------------|
| Video UUID | Truncated PeerTube UUID (hover for full value) |
| YouTube ID | The 11-character YouTube video ID |
| Segments | Number of cached SponsorBlock segments |
| Time Saved | Total segment duration for this video |
| Last Sync | When segments were last fetched (relative time) |
| Queue | Processing queue status badge (Pending / Processing / Done / Error) |
| Actions | Per-row action buttons (see below) |

### Per-Row Actions

| Button | What it does |
|--------|-------------|
| **Sync** | Re-fetches segments from SponsorBlock for this single video and updates the cache. |
| **Process** | Queues this video for FFmpeg segment removal. Only useful in remove mode. |
| **Delete** | Removes the mapping. If no other video shares the same YouTube ID, the cached segments are also deleted. Asks for confirmation before proceeding. |

---

## 5. Manual Mapping (Video Watch Page)

Admins and moderators see a **SponsorBlock** widget below the video player on the watch page.

1. Click the **SponsorBlock** toggle to expand the widget
2. Enter a YouTube video ID (e.g., `dQw4w9WgXcQ`) or a full YouTube URL
3. Click **Link**
4. The plugin creates the mapping, fetches segments, and activates skipping immediately

This is useful for:
- Videos imported through methods that don't trigger the import hook
- Manually correcting a wrong mapping
- Linking a re-uploaded version of a YouTube video

---

## 6. Progress Bar Markers

On the video watch page, sponsor segments are displayed as colored overlays on the progress bar. Each category has a distinct color:

| Category | Color |
|----------|-------|
| Sponsor | Green |
| Self-promotion | Yellow |
| Interaction | Light blue |
| Intro | Cyan |
| Outro | Blue |
| Preview | Orange |
| Off-topic music | Magenta |
| Filler | Purple |

Hovering over a marker shows a tooltip with the category name and time range.

---

## 7. Periodic Sync

To keep segment data up to date (new community submissions, revised timestamps), configure the **Periodic sync interval**:

1. Go to plugin settings
2. Set **Periodic sync interval (hours)** to the desired value (e.g., `24` for daily)
3. Save

The plugin checks every 5 minutes whether the interval has elapsed. When it triggers, it iterates all mappings and re-fetches segments from SponsorBlock with 200ms rate limiting.

Set to `0` to disable periodic sync entirely.

---

## 8. API Reference

All routes are prefixed with `/plugins/sponsorblock/router`.

### Public Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/segments/:videoUuid` | Returns cached segments for a video |
| `GET` | `/mapping/:videoUuid` | Returns the YouTube mapping for a video |

### Admin/Moderator Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/mapping/:videoUuid` | Create or update a YouTube mapping |
| `POST` | `/scan` | Scan imports and create new mappings |
| `POST` | `/sync/:videoUuid` | Re-fetch segments for one video |
| `POST` | `/process/:videoUuid` | Queue one video for FFmpeg processing |
| `POST` | `/process-all` | Queue all unprocessed videos |

### Admin-Only Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin/stats` | Dashboard statistics |
| `GET` | `/admin/mappings` | All mappings with segment counts and queue status |
| `DELETE` | `/mapping/:videoUuid` | Delete a mapping and orphaned segments |
| `POST` | `/sync-all` | Re-fetch segments for all mappings (background) |

All admin routes require an admin authentication token (`Authorization: Bearer <token>`).

---

## 9. Migrating Existing Videos

If you install the plugin on an instance that already has YouTube-imported videos:

1. Open the plugin settings page
2. Click **Scan Imports** in the admin dashboard
3. The plugin scans the `videoImport` table, finds YouTube URLs, creates mappings, and fetches segments

Alternatively, use the API:

```bash
curl -X POST http://your-instance/plugins/sponsorblock/router/scan \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

---

## 10. Troubleshooting

### Segments are not skipped

1. Open the browser developer console (F12)
2. Look for `[SponsorBlock]` log messages
3. Verify segments are fetched: you should see `Found X segments to skip`
4. Try a hard refresh (Ctrl+Shift+R) to clear cached scripts
5. Check the API directly: `GET /plugins/sponsorblock/router/segments/<video-uuid>`

### No markers on the progress bar

- Markers only appear if segments exist for that video
- The video duration must be available (markers are added after `durationchange`)
- Check the console for `Added X progress bar markers`

### The dashboard shows no data

- Ensure you are logged in as an admin (role 0)
- Click **Scan Imports** if no mappings exist yet
- Check the PeerTube logs for SQL errors: `sudo journalctl -u peertube -f`

### FFmpeg processing fails

- Verify FFmpeg is installed: `ffmpeg -version`
- Check `storage_path` points to the correct directory
- Check PeerTube logs for the specific error message
- The worker retries up to 3 times before marking a job as `error`
- You can re-queue a failed video by clicking **Process** in the dashboard

### Plugin does not activate

- Check PeerTube version: the plugin requires >= 6.0.0
- Check logs: `sudo journalctl -u peertube -f | grep -i sponsorblock`
- Verify file permissions on the plugin directory

---

## 11. Uninstallation

Via the PeerTube admin interface: **Administration > Plugins/Themes > SponsorBlock > Uninstall**.

Or via CLI:

```bash
cd /var/www/peertube
sudo -u peertube NODE_CONFIG_DIR=/var/www/peertube/config NODE_ENV=production \
  npm run plugin:uninstall -- --npm-name peertube-plugin-sponsorblock
```

The plugin's database tables (`plugin_sponsorblock_mapping`, `plugin_sponsorblock_segments`, `plugin_sponsorblock_processing_queue`) are **not** automatically dropped. To remove them manually:

```sql
DROP TABLE IF EXISTS plugin_sponsorblock_processing_queue;
DROP TABLE IF EXISTS plugin_sponsorblock_segments;
DROP TABLE IF EXISTS plugin_sponsorblock_mapping;
```
