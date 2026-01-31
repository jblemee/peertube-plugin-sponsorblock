/**
 * PeerTube Plugin SponsorBlock
 * Main entry point for server-side plugin
 */

const { registerRoutes } = require('./server/routes');
const { getVideoDuration, processVideoFile, findVideoFiles, regenerateHlsMetadata, regenerateStoryboard } = require('./server/ffmpeg');
const { extractYoutubeId, fetchAndCacheSegments } = require('./server/shared');

let workerIntervalId = null;
let syncIntervalId = null;
let lastSyncCheck = 0;

async function register({
  registerHook,
  registerSetting,
  settingsManager,
  peertubeHelpers,
  getRouter
}) {
  const logger = peertubeHelpers.logger;

  logger.info('Registering PeerTube SponsorBlock plugin');

  // Register settings
  registerSettings(registerSetting);

  // Initialize database tables
  await initDatabase(peertubeHelpers);

  // Register API routes
  const router = getRouter();
  await registerRoutes({ router, peertubeHelpers, settingsManager });

  // Register hooks for video import
  registerHooks(registerHook, peertubeHelpers, settingsManager);

  // Start background worker for processing
  await startWorker(peertubeHelpers, settingsManager);

  // Start periodic sync timer
  startSyncTimer(peertubeHelpers, settingsManager);

  logger.info('PeerTube SponsorBlock plugin registered successfully');
}

async function unregister() {
  if (workerIntervalId) {
    clearInterval(workerIntervalId);
    workerIntervalId = null;
  }
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
}

/**
 * Register plugin settings
 */
function registerSettings(registerSetting) {
  // Mode: skip (client-side) or remove (automatic permanent deletion)
  registerSetting({
    name: 'mode',
    label: 'Operation mode',
    type: 'select',
    options: [
      { label: 'Skip segments (client-side)', value: 'skip' },
      { label: 'Remove segments automatically (FFmpeg)', value: 'remove' }
    ],
    default: 'skip',
    descriptionHTML: 'Skip: segments are skipped during playback. Remove: segments are also automatically cut from video files on import. In both modes, you can trigger permanent removal manually via the Process button in the dashboard.'
  });

  // Enable/disable categories
  const categories = [
    { name: 'sponsor', label: 'Sponsors', default: true },
    { name: 'selfpromo', label: 'Self-promotion', default: true },
    { name: 'interaction', label: 'Interaction reminders', default: true },
    { name: 'intro', label: 'Intros', default: false },
    { name: 'outro', label: 'Outros', default: false },
    { name: 'preview', label: 'Previews/Recaps', default: false },
    { name: 'music_offtopic', label: 'Off-topic music', default: false },
    { name: 'filler', label: 'Filler content', default: false }
  ];

  categories.forEach(cat => {
    registerSetting({
      name: `category_${cat.name}`,
      label: `Skip/Remove ${cat.label}`,
      type: 'input-checkbox',
      default: cat.default
    });
  });

  // Advanced settings
  registerSetting({
    name: 'api_url',
    label: 'SponsorBlock API URL',
    type: 'input',
    default: 'https://sponsor.ajay.app',
    private: true
  });

  registerSetting({
    name: 'cache_duration',
    label: 'Cache duration (hours)',
    type: 'input',
    default: 24,
    descriptionHTML: 'How long to cache SponsorBlock segments before refreshing'
  });

  registerSetting({
    name: 'show_notifications',
    label: 'Show skip notifications',
    type: 'input-checkbox',
    default: true,
    descriptionHTML: 'Display a notification when a segment is skipped'
  });

  registerSetting({
    name: 'storage_path',
    label: 'PeerTube storage path',
    type: 'input',
    default: '/var/www/peertube/storage',
    private: true,
    descriptionHTML: 'Absolute path to the PeerTube storage directory. Required for remove mode.'
  });

  registerSetting({
    name: 'sync_interval',
    label: 'Periodic sync interval (hours)',
    type: 'input',
    default: '0',
    descriptionHTML: 'Automatically re-fetch segments for all mapped videos at this interval. Set to 0 to disable.'
  });

}

/**
 * Initialize database tables
 */
async function initDatabase(peertubeHelpers) {
  const logger = peertubeHelpers.logger;
  const database = peertubeHelpers.database;

  try {
    // Table: YouTube ID to PeerTube UUID mapping
    await database.query(`
      CREATE TABLE IF NOT EXISTS plugin_sponsorblock_mapping (
        peertube_uuid UUID PRIMARY KEY,
        youtube_id VARCHAR(11) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        last_sync TIMESTAMP,
        segments_removed BOOLEAN DEFAULT FALSE
      );
    `);

    // Migration: add segments_removed column if missing (existing installs)
    await database.query(`
      ALTER TABLE plugin_sponsorblock_mapping
        ADD COLUMN IF NOT EXISTS segments_removed BOOLEAN DEFAULT FALSE;
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_sponsorblock_youtube_id
        ON plugin_sponsorblock_mapping(youtube_id);
    `);

    // Table: SponsorBlock segments cache
    await database.query(`
      CREATE TABLE IF NOT EXISTS plugin_sponsorblock_segments (
        id SERIAL PRIMARY KEY,
        youtube_id VARCHAR(11) NOT NULL,
        segment_uuid VARCHAR(128) NOT NULL,
        start_time FLOAT NOT NULL,
        end_time FLOAT NOT NULL,
        category VARCHAR(50) NOT NULL,
        action_type VARCHAR(20) NOT NULL,
        votes INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(segment_uuid)
      );
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_segments_youtube_id
        ON plugin_sponsorblock_segments(youtube_id);
    `);

    // Table: Processing queue for video modification
    await database.query(`
      CREATE TABLE IF NOT EXISTS plugin_sponsorblock_processing_queue (
        id SERIAL PRIMARY KEY,
        video_uuid UUID NOT NULL,
        youtube_id VARCHAR(11) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        priority INTEGER DEFAULT 0,
        segments JSONB NOT NULL,
        error TEXT,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3,
        cut_completed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        started_at TIMESTAMP,
        completed_at TIMESTAMP
      );
    `);

    // Migration: add cut_completed column if missing (existing installs)
    await database.query(`
      ALTER TABLE plugin_sponsorblock_processing_queue
        ADD COLUMN IF NOT EXISTS cut_completed BOOLEAN DEFAULT FALSE;
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_queue_status
        ON plugin_sponsorblock_processing_queue(status, priority, created_at);
    `);

    logger.info('Database tables initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize database tables', error);
    throw error;
  }
}

/**
 * Register hooks for video import
 */
function registerHooks(registerHook, peertubeHelpers, settingsManager) {
  const logger = peertubeHelpers.logger;
  const database = peertubeHelpers.database;

  // Hook: Clean up mapping and segments when a video is deleted
  registerHook({
    target: 'action:api.video.deleted',
    handler: async ({ video }) => {
      try {
        const [mappings] = await database.query(
          'SELECT youtube_id FROM plugin_sponsorblock_mapping WHERE peertube_uuid = $1',
          { bind: [video.uuid] }
        );

        if (!mappings || mappings.length === 0) return;

        const youtubeId = mappings[0].youtube_id;

        await database.query(
          'DELETE FROM plugin_sponsorblock_mapping WHERE peertube_uuid = $1',
          { bind: [video.uuid] }
        );
        await database.query(
          'DELETE FROM plugin_sponsorblock_segments WHERE youtube_id = $1',
          { bind: [youtubeId] }
        );
        await database.query(
          'DELETE FROM plugin_sponsorblock_processing_queue WHERE video_uuid = $1',
          { bind: [video.uuid] }
        );

        logger.info(`Cleaned up SponsorBlock data for deleted video ${video.uuid}`);
      } catch (error) {
        logger.error('Error cleaning up after video deletion', error);
      }
    }
  });

  // Hook: After video import from URL
  registerHook({
    target: 'filter:api.video.post-import-url.accept.result',
    handler: async (result, params) => {
      try {
        const { videoImport, video } = params;

        if (!videoImport || !video) {
          return result;
        }

        const targetUrl = videoImport.targetUrl;
        const youtubeId = extractYoutubeId(targetUrl);

        if (!youtubeId) {
          logger.debug(`No YouTube ID found in URL: ${targetUrl}`);
          return result;
        }

        logger.info(`Video imported from YouTube: ${youtubeId} -> ${video.uuid}`);

        // Save mapping
        await saveYouTubeMapping(
          peertubeHelpers,
          video.uuid,
          youtubeId
        );

        // Fetch and cache SponsorBlock segments
        await fetchAndCacheSegments({
          database: peertubeHelpers.database,
          settingsManager,
          youtubeId,
          logger
        });

        // Auto-queue for FFmpeg processing in remove mode
        const mode = await settingsManager.getSetting('mode');
        if (mode === 'remove') {
          await queueVideoProcessing(
            peertubeHelpers,
            video.uuid,
            youtubeId
          );
        }

      } catch (error) {
        logger.error('Error in post-import hook', error);
      }

      return result;
    }
  });
}

/**
 * Save YouTube ID to PeerTube UUID mapping
 */
async function saveYouTubeMapping(peertubeHelpers, peertubeUuid, youtubeId) {
  const database = peertubeHelpers.database;

  await database.query(`
    INSERT INTO plugin_sponsorblock_mapping (peertube_uuid, youtube_id)
    VALUES ($1, $2)
    ON CONFLICT (peertube_uuid) DO UPDATE
      SET youtube_id = $2, last_sync = NOW()
  `, { bind: [peertubeUuid, youtubeId] });
}

/**
 * Queue video for processing (removal mode)
 */
async function queueVideoProcessing(peertubeHelpers, videoUuid, youtubeId) {
  const logger = peertubeHelpers.logger;
  const database = peertubeHelpers.database;

  try {
    // Get segments
    const [segments] = await database.query(`
      SELECT start_time, end_time, category
      FROM plugin_sponsorblock_segments
      WHERE youtube_id = $1
      ORDER BY start_time ASC
    `, { bind: [youtubeId] });

    if (!segments || segments.length === 0) {
      logger.debug(`No segments to process for ${videoUuid}`);
      return;
    }

    // Add to processing queue
    await database.query(`
      INSERT INTO plugin_sponsorblock_processing_queue
      (video_uuid, youtube_id, segments, priority)
      VALUES ($1, $2, $3, 10)
    `, { bind: [videoUuid, youtubeId, JSON.stringify(segments)] });

    logger.info(`Queued video ${videoUuid} for processing (${segments.length} segments)`);

  } catch (error) {
    logger.error(`Failed to queue video ${videoUuid}`, error);
  }
}

/**
 * Start background worker for processing queue
 */
async function startWorker(peertubeHelpers, settingsManager) {
  const logger = peertubeHelpers.logger;
  const database = peertubeHelpers.database;

  let processing = false;

  workerIntervalId = setInterval(async () => {
    if (processing) return;

    try {
      processing = true;

      // Claim next pending job using advisory lock pattern
      const [claimed] = await database.query(`
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

      if (!claimed || claimed.length === 0) {
        return;
      }

      const job = claimed[0];
      logger.info(`Worker claimed job ${job.id} for video ${job.video_uuid}`);

      try {
        const storagePath = await settingsManager.getSetting('storage_path') || '/var/www/peertube/storage';
        const videoFiles = await findVideoFiles(database, job.video_uuid, storagePath, logger);

        if (videoFiles.length === 0) {
          throw new Error('No local video files found');
        }

        const segments = typeof job.segments === 'string' ? JSON.parse(job.segments) : job.segments;

        // Phase 1: Cut segments from all video files (skip on retry if already done)
        if (!job.cut_completed) {
          for (const file of videoFiles) {
            logger.info(`Cutting file: ${file.type} - ${file.path}`);
            const duration = await getVideoDuration(file.path);
            await processVideoFile(file.path, segments, duration, logger);
          }

          // Mark cuts as done so retries don't re-cut
          await database.query(`
            UPDATE plugin_sponsorblock_processing_queue
            SET cut_completed = TRUE
            WHERE id = $1
          `, { bind: [job.id] });
        } else {
          logger.info(`Job ${job.id}: cuts already completed, skipping to HLS regeneration`);
        }

        // Phase 2: Post-processing (HLS regen + storyboard)
        for (const file of videoFiles) {
          if (file.type === 'hls') {
            await regenerateHlsMetadata(file.path, logger);
          }
        }

        // Regenerate storyboard from the best available file
        const bestFile = videoFiles.find(f => f.type === 'web-video') || videoFiles.find(f => f.type === 'original') || videoFiles[0];
        if (!bestFile) {
          logger.warn(`Job ${job.id}: no suitable file found for storyboard regeneration, skipping`);
        } else {
          await regenerateStoryboard(bestFile.path, job.video_uuid, database, storagePath, logger);
        }

        // Mark job as done
        await database.query(`
          UPDATE plugin_sponsorblock_processing_queue
          SET status = 'done', completed_at = NOW()
          WHERE id = $1
        `, { bind: [job.id] });

        // Mark mapping as having segments physically removed
        await database.query(`
          UPDATE plugin_sponsorblock_mapping
          SET segments_removed = TRUE
          WHERE peertube_uuid = $1
        `, { bind: [job.video_uuid] });

        logger.info(`Job ${job.id} completed successfully`);

      } catch (error) {
        logger.error(`Job ${job.id} failed`, error);

        const newRetryCount = (job.retry_count || 0) + 1;
        const maxRetries = job.max_retries || 3;

        if (newRetryCount >= maxRetries) {
          await database.query(`
            UPDATE plugin_sponsorblock_processing_queue
            SET status = 'error', error = $2, retry_count = $3, completed_at = NOW()
            WHERE id = $1
          `, { bind: [job.id, String(error.message), newRetryCount] });
        } else {
          await database.query(`
            UPDATE plugin_sponsorblock_processing_queue
            SET status = 'pending', error = $2, retry_count = $3, started_at = NULL
            WHERE id = $1
          `, { bind: [job.id, String(error.message), newRetryCount] });
        }
      }
    } catch (error) {
      logger.error('Worker error', error);
    } finally {
      processing = false;
    }
  }, 30000);

  logger.info('Background worker started (30s polling)');
}

/**
 * Start periodic sync timer
 * Checks every 5 minutes if sync_interval has elapsed, then re-fetches all segments
 */
function startSyncTimer(peertubeHelpers, settingsManager) {
  const logger = peertubeHelpers.logger;
  const database = peertubeHelpers.database;
  const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

  syncIntervalId = setInterval(async () => {
    try {
      const intervalHours = parseFloat(await settingsManager.getSetting('sync_interval')) || 0;
      if (intervalHours <= 0) return;

      const intervalMs = intervalHours * 3600 * 1000;
      const now = Date.now();

      if (lastSyncCheck > 0 && (now - lastSyncCheck) < intervalMs) return;

      lastSyncCheck = now;
      logger.info('Periodic sync: starting');

      const [mappings] = await database.query(
        'SELECT peertube_uuid, youtube_id FROM plugin_sponsorblock_mapping'
      );

      for (const mapping of (mappings || [])) {
        try {
          await fetchAndCacheSegments({
            database,
            settingsManager,
            youtubeId: mapping.youtube_id,
            logger
          });

          await database.query(
            'UPDATE plugin_sponsorblock_mapping SET last_sync = NOW() WHERE peertube_uuid = $1',
            { bind: [mapping.peertube_uuid] }
          );
        } catch (err) {
          logger.error(`Periodic sync: failed for ${mapping.youtube_id}`, err);
        }

        // Rate limit: 200ms between requests
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      logger.info(`Periodic sync: complete (${(mappings || []).length} mappings)`);
    } catch (error) {
      logger.error('Periodic sync error', error);
    }
  }, CHECK_INTERVAL);

  logger.info('Periodic sync timer started (5-min check interval)');
}

module.exports = {
  register,
  unregister
};
