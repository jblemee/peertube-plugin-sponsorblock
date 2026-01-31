# PeerTube SponsorBlock Plugin

Automatically skip or permanently remove sponsored segments from YouTube videos imported into your PeerTube instance.

**What it does:** When you import a video from YouTube, this plugin checks the [SponsorBlock](https://sponsor.ajay.app) database and automatically skips (or removes) sponsored segments, intros, outros, and more.

---

## Quick Start

### Installation

1. Go to **Administration** > **Plugins/Themes** in your PeerTube instance
2. Search for **SponsorBlock** in the plugins list
3. Click **Install** and then **Enable**

Or install via CLI:

```bash
cd /var/www/peertube
sudo -u peertube NODE_CONFIG_DIR=/var/www/peertube/config NODE_ENV=production \
  npm run plugin:install -- --npm-name peertube-plugin-sponsorblock
```

### Basic Usage

1. Enable the plugin in **Plugins/Themes**
2. Configure your preferred settings (see below)
3. Import videos from YouTube as usual — SponsorBlock segments will be handled automatically!

---

## Features

### What works right now

| Feature | Description |
|---------|-------------|
| **Auto-skip** | Segments are automatically skipped during playback |
| **Visual markers** | See sponsor segments on the video progress bar |
| **Multiple categories** | Skip sponsors, intros, outros, self-promo, and more |
| **Admin dashboard** | View stats, manage mappings, and sync segments |
| **Permanent removal** | Optionally cut segments from video files permanently |
| **Automatic detection** | Works automatically when importing YouTube videos |

### Two modes of operation

**Skip mode (default)**
- Segments are skipped automatically during playback
- No files are modified
- Works for any video imported from YouTube
- Can be configured per category (sponsor, intro, interaction, etc.)

**Remove mode**
- Segments are permanently cut from the video file
- Saves bandwidth and storage
- Irreversible — use with backups
- Requires FFmpeg installed on your server

---

## Configuration

### Settings

| Setting | Description |
|---------|-------------|
| **Mode** | Choose `skip` (client-side) or `remove` (permanent) |
| **Categories to skip** | Select which segment types to skip (sponsor, intro, outro, self-promo, interaction, music_offtopic) |
| **Storage path** | Where to store processed videos (remove mode only) |
| **Sync interval** | How often to refresh segment data from SponsorBlock |

### Admin Dashboard

Access the dashboard at **Administration** > **Plugins** > **SponsorBlock** > **Go to plugin settings**:

- **Stats cards**: See mapped videos, total segments, time saved, and pending jobs
- **Mappings table**: View all YouTube-to-PeerTube mappings with actions
- **Bulk actions**: Scan imports, sync all, or process all videos at once

---

## How it works

1. When you import a video from YouTube, the plugin detects the YouTube video ID
2. It queries the SponsorBlock API for sponsor segments
3. Segments are cached locally in your database
4. During playback, segments are automatically skipped (or removed from the file)

### What is SponsorBlock?

SponsorBlock is a crowdsourced database of video segments. Users submit timestamps for:
- **Sponsors** - Paid promotions and sponsorships
- **Intro** - Animated introductions
- **Outro** - Credits and end screens
- **Self-promo** - Unpaid promotion of creator's content
- **Interaction** - Reminders to like, subscribe, follow
- **Music off-topic** - Non-music sections in music videos

Learn more at [sponsor.ajay.app](https://sponsor.ajay.app)

---

## Important Notes

### Skip mode (recommended for most users)
- Segments are still downloaded (no bandwidth savings)
- Only works in the PeerTube web player
- Reversible — you can disable it anytime

### Remove mode (advanced users)
- **Irreversible** — video files are permanently modified
- Saves bandwidth and storage space
- Removes **all** segment types (category settings don't apply)
- Comment timestamps may shift after removal
- **Requires automatic backups** — use at your own risk
- Requires `ffmpeg` and `ffprobe` installed on your server

---

## Documentation

- **[User Guide](USER_GUIDE.md)** - Detailed installation and configuration
- **[Development Guide](DEVELOPMENT.md)** - For contributors and developers
- **[Changelog](CHANGELOG.md)** - Version history and updates

---

## Requirements

- PeerTube >= 6.0.0
- For remove mode: `ffmpeg` and `ffprobe` in system PATH

---

## License

AGPL-3.0 (compatible with PeerTube)

---

## Support & Contributing

- **Issues**: [GitHub Issues](https://github.com/jblemee/peertube-plugin-sponsorblock/issues)
- **Source Code**: [GitHub Repository](https://github.com/jblemee/peertube-plugin-sponsorblock)

Contributions welcome! Testing on development instances is especially appreciated.

---

**Author**: Jean-Baptiste L.
