/**
 * PeerTube Plugin SponsorBlock
 * Main entry point for server-side plugin
 */

const { registerRoutes, ALL_CATEGORIES } = require('./server/routes')
const { getVideoDuration, processVideoFile, findVideoFiles } = require('./server/ffmpeg')
const { URL } = require('url')

const CATEGORIES_PARAM = `&categories=${encodeURIComponent(JSON.stringify(ALL_CATEGORIES))}`

/**
 * Validate that an API URL is safe (not targeting internal/private networks)
 * Rejects private IPs, loopback, link-local, and non-HTTPS schemes
 */
function validateApiUrl(urlString) {
  let parsed
  try {
    parsed = new URL(urlString)
  } catch {
    throw new Error(`Invalid API URL: ${urlString}`)
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`API URL must use HTTPS, got: ${parsed.protocol}`)
  }

  const hostname = parsed.hostname

  // Reject IPv6 private/loopback
  if (hostname.startsWith('[')) {
    const ipv6 = hostname.slice(1, -1).toLowerCase()
    if (ipv6 === '::1' || ipv6.startsWith('fc') || ipv6.startsWith('fd') || ipv6.startsWith('fe80')) {
      throw new Error(`API URL must not target private/internal addresses: ${hostname}`)
    }
  }

  // Reject IPv4 private/loopback/link-local ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number)
    if (
      a === 127 ||                          // 127.0.0.0/8 loopback
      a === 10 ||                           // 10.0.0.0/8 private
      (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12 private
      (a === 192 && b === 168) ||           // 192.168.0.0/16 private
      (a === 169 && b === 254) ||           // 169.254.0.0/16 link-local
      a === 0                               // 0.0.0.0/8
    ) {
      throw new Error(`API URL must not target private/internal addresses: ${hostname}`)
    }
  }

  // Reject localhost by name
  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error(`API URL must not target local addresses: ${hostname}`)
  }

  return parsed.toString()
}

/**
 * Validate a segment from the SponsorBlock API response
 */
function validateSegment(segment) {
  if (!segment || typeof segment !== 'object') return false
  if (typeof segment.UUID !== 'string' || segment.UUID.length === 0 || segment.UUID.length > 128) return false
  if (!Array.isArray(segment.segment) || segment.segment.length !== 2) return false
  const [start, end] = segment.segment
  if (typeof start !== 'number' || typeof end !== 'number') return false
  if (start < 0 || end < 0 || start >= end) return false
  if (!isFinite(start) || !isFinite(end)) return false
  if (typeof segment.category !== 'string' || segment.category.length === 0 || segment.category.length > 50) return false
  if (segment.votes !== undefined && typeof segment.votes !== 'number') return false
  return true
}

let workerIntervalId = null
let syncIntervalId = null
let lastSyncCheck = 0

async function register({
  registerHook,
  registerSetting,
  settingsManager,
  storageManager,
  videoCategoryManager,
  videoLicenceManager,
  videoLanguageManager,
  peertubeHelpers,
  getRouter
}) {
  const logger = peertubeHelpers.logger

  logger.info('Registering PeerTube SponsorBlock plugin')

  // Register settings
  registerSettings(registerSetting)

  // Initialize database tables
  await initDatabase(peertubeHelpers)

  // Register API routes
  const router = getRouter()
  await registerRoutes({ router, peertubeHelpers, settingsManager })

  // Register hooks for video import
  registerImportHooks(registerHook, peertubeHelpers, settingsManager)

  // Start background worker for processing
  await startWorker(peertubeHelpers, settingsManager)

  // Start periodic sync timer
  startSyncTimer(peertubeHelpers, settingsManager)

  logger.info('PeerTube SponsorBlock plugin registered successfully')
}

async function unregister() {
  if (workerIntervalId) {
    clearInterval(workerIntervalId)
    workerIntervalId = null
  }
  if (syncIntervalId) {
    clearInterval(syncIntervalId)
    syncIntervalId = null
  }
}

/**
 * Register plugin settings
 */
function registerSettings(registerSetting) {
  // Mode: skip (client-side) or remove (permanent deletion)
  registerSetting({
    name: 'mode',
    label: 'Operation mode',
    type: 'select',
    options: [
      { label: 'Skip segments (client-side)', value: 'skip' },
      { label: 'Remove segments permanently (experimental)', value: 'remove' }
    ],
    default: 'skip',
    descriptionHTML: 'Skip mode: Segments are skipped during playback. Remove mode: Segments are permanently deleted from video files (requires FFmpeg).'
  })

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
  ]

  categories.forEach(cat => {
    registerSetting({
      name: `category_${cat.name}`,
      label: `Skip/Remove ${cat.label}`,
      type: 'input-checkbox',
      default: cat.default
    })
  })

  // Advanced settings
  registerSetting({
    name: 'api_url',
    label: 'SponsorBlock API URL',
    type: 'input',
    default: 'https://sponsor.ajay.app',
    private: true
  })

  registerSetting({
    name: 'cache_duration',
    label: 'Cache duration (hours)',
    type: 'input',
    default: 24,
    descriptionHTML: 'How long to cache SponsorBlock segments before refreshing'
  })

  registerSetting({
    name: 'show_notifications',
    label: 'Show skip notifications',
    type: 'input-checkbox',
    default: true,
    descriptionHTML: 'Display a notification when a segment is skipped'
  })

  registerSetting({
    name: 'storage_path',
    label: 'PeerTube storage path',
    type: 'input',
    default: '/var/www/peertube/storage',
    private: true,
    descriptionHTML: 'Absolute path to the PeerTube storage directory. Required for remove mode.'
  })

  registerSetting({
    name: 'sync_interval',
    label: 'Periodic sync interval (hours)',
    type: 'input',
    default: '0',
    descriptionHTML: 'Automatically re-fetch segments for all mapped videos at this interval. Set to 0 to disable.'
  })

  registerSetting({
    name: 'admin-dashboard-container',
    type: 'html',
    html: '<div id="sponsorblock-admin-dashboard"></div>'
  })
}

/**
 * Initialize database tables
 */
async function initDatabase(peertubeHelpers) {
  const logger = peertubeHelpers.logger
  const database = peertubeHelpers.database

  try {
    // Table: YouTube ID to PeerTube UUID mapping
    await database.query(`
      CREATE TABLE IF NOT EXISTS plugin_sponsorblock_mapping (
        peertube_uuid UUID PRIMARY KEY,
        youtube_id VARCHAR(11) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        last_sync TIMESTAMP
      );
    `)

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_sponsorblock_youtube_id
        ON plugin_sponsorblock_mapping(youtube_id);
    `)

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
    `)

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_segments_youtube_id
        ON plugin_sponsorblock_segments(youtube_id);
    `)

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
        created_at TIMESTAMP DEFAULT NOW(),
        started_at TIMESTAMP,
        completed_at TIMESTAMP
      );
    `)

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_queue_status
        ON plugin_sponsorblock_processing_queue(status, priority, created_at);
    `)

    logger.info('Database tables initialized successfully')
  } catch (error) {
    logger.error('Failed to initialize database tables', error)
    throw error
  }
}

/**
 * Register hooks for video import
 */
function registerImportHooks(registerHook, peertubeHelpers, settingsManager) {
  const logger = peertubeHelpers.logger

  // Hook: After video import from URL
  registerHook({
    target: 'filter:api.video.post-import-url.accept.result',
    handler: async (result, params) => {
      try {
        const { videoImport, video } = params

        if (!videoImport || !video) {
          return result
        }

        const targetUrl = videoImport.targetUrl
        const youtubeId = extractYouTubeId(targetUrl)

        if (!youtubeId) {
          logger.debug(`No YouTube ID found in URL: ${targetUrl}`)
          return result
        }

        logger.info(`Video imported from YouTube: ${youtubeId} -> ${video.uuid}`)

        // Save mapping
        await saveYouTubeMapping(
          peertubeHelpers,
          video.uuid,
          youtubeId
        )

        // Fetch and cache SponsorBlock segments
        await fetchAndCacheSegments(
          peertubeHelpers,
          settingsManager,
          youtubeId
        )

        // Queue for processing if remove mode is enabled
        const mode = await settingsManager.getSetting('mode')
        if (mode === 'remove') {
          await queueVideoProcessing(
            peertubeHelpers,
            video.uuid,
            youtubeId
          )
        }

      } catch (error) {
        logger.error('Error in post-import hook', error)
      }

      return result
    }
  })
}

/**
 * Extract YouTube video ID from URL
 */
function extractYouTubeId(url) {
  if (!url) return null

  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/
  ]

  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match) return match[1]
  }

  return null
}

/**
 * Save YouTube ID to PeerTube UUID mapping
 */
async function saveYouTubeMapping(peertubeHelpers, peertubeUuid, youtubeId) {
  const database = peertubeHelpers.database

  await database.query(`
    INSERT INTO plugin_sponsorblock_mapping (peertube_uuid, youtube_id)
    VALUES ($1, $2)
    ON CONFLICT (peertube_uuid) DO UPDATE
      SET youtube_id = $2, last_sync = NOW()
  `, { bind: [peertubeUuid, youtubeId] })
}

/**
 * Fetch segments from SponsorBlock API and cache them
 */
async function fetchAndCacheSegments(peertubeHelpers, settingsManager, youtubeId) {
  const logger = peertubeHelpers.logger
  const database = peertubeHelpers.database

  try {
    const apiUrl = await settingsManager.getSetting('api_url') || 'https://sponsor.ajay.app'
    validateApiUrl(apiUrl)
    const url = `${apiUrl}/api/skipSegments?videoID=${youtubeId}${CATEGORIES_PARAM}`

    logger.debug(`Fetching SponsorBlock segments for ${youtubeId}`)

    const response = await fetch(url)

    if (!response.ok) {
      if (response.status === 404) {
        logger.debug(`No segments found for ${youtubeId}`)
        return
      }
      throw new Error(`SponsorBlock API error: ${response.status}`)
    }

    const segments = await response.json()

    // Delete old and insert new segments in a transaction
    await database.query('BEGIN')
    try {
      await database.query(`
        DELETE FROM plugin_sponsorblock_segments WHERE youtube_id = $1
      `, { bind: [youtubeId] })

      let cached = 0
      for (const segment of segments) {
        if (!validateSegment(segment)) {
          logger.warn(`Skipping invalid segment from API: ${JSON.stringify(segment).slice(0, 200)}`)
          continue
        }
        await database.query(`
          INSERT INTO plugin_sponsorblock_segments
          (youtube_id, segment_uuid, start_time, end_time, category, action_type, votes)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (segment_uuid) DO NOTHING
        `, { bind: [
          youtubeId,
          segment.UUID,
          segment.segment[0],
          segment.segment[1],
          segment.category,
          segment.actionType || 'skip',
          segment.votes || 0
        ] })
        cached++
      }

      await database.query('COMMIT')
      logger.info(`Cached ${cached} segments for ${youtubeId}`)
    } catch (txError) {
      await database.query('ROLLBACK')
      throw txError
    }

  } catch (error) {
    logger.error(`Failed to fetch segments for ${youtubeId}`, error)
  }
}

/**
 * Queue video for processing (removal mode)
 */
async function queueVideoProcessing(peertubeHelpers, videoUuid, youtubeId) {
  const logger = peertubeHelpers.logger
  const database = peertubeHelpers.database

  try {
    // Get segments
    const [segments] = await database.query(`
      SELECT start_time, end_time, category
      FROM plugin_sponsorblock_segments
      WHERE youtube_id = $1
      ORDER BY start_time ASC
    `, { bind: [youtubeId] })

    if (!segments || segments.length === 0) {
      logger.debug(`No segments to process for ${videoUuid}`)
      return
    }

    // Add to processing queue
    await database.query(`
      INSERT INTO plugin_sponsorblock_processing_queue
      (video_uuid, youtube_id, segments, priority)
      VALUES ($1, $2, $3, 10)
    `, { bind: [videoUuid, youtubeId, JSON.stringify(segments)] })

    logger.info(`Queued video ${videoUuid} for processing (${segments.length} segments)`)

  } catch (error) {
    logger.error(`Failed to queue video ${videoUuid}`, error)
  }
}

/**
 * Start background worker for processing queue
 */
async function startWorker(peertubeHelpers, settingsManager) {
  const logger = peertubeHelpers.logger
  const database = peertubeHelpers.database

  let processing = false

  workerIntervalId = setInterval(async () => {
    if (processing) return

    try {
      const mode = await settingsManager.getSetting('mode')
      if (mode !== 'remove') return

      processing = true

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
      `)

      if (!claimed || claimed.length === 0) {
        return
      }

      const job = claimed[0]
      logger.info(`Worker claimed job ${job.id} for video ${job.video_uuid}`)

      try {
        const storagePath = await settingsManager.getSetting('storage_path') || '/var/www/peertube/storage'
        const videoFiles = await findVideoFiles(database, job.video_uuid, storagePath, logger)

        if (videoFiles.length === 0) {
          throw new Error('No local video files found')
        }

        const segments = typeof job.segments === 'string' ? JSON.parse(job.segments) : job.segments

        for (const file of videoFiles) {
          logger.info(`Processing file: ${file.type} - ${file.path}`)
          const duration = await getVideoDuration(file.path)
          await processVideoFile(file.path, segments, duration, logger)
        }

        // Mark as done
        await database.query(`
          UPDATE plugin_sponsorblock_processing_queue
          SET status = 'done', completed_at = NOW()
          WHERE id = $1
        `, { bind: [job.id] })

        logger.info(`Job ${job.id} completed successfully`)

      } catch (error) {
        logger.error(`Job ${job.id} failed`, error)

        const newRetryCount = (job.retry_count || 0) + 1
        const maxRetries = job.max_retries || 3

        if (newRetryCount >= maxRetries) {
          await database.query(`
            UPDATE plugin_sponsorblock_processing_queue
            SET status = 'error', error = $2, retry_count = $3, completed_at = NOW()
            WHERE id = $1
          `, { bind: [job.id, String(error.message), newRetryCount] })
        } else {
          await database.query(`
            UPDATE plugin_sponsorblock_processing_queue
            SET status = 'pending', error = $2, retry_count = $3, started_at = NULL
            WHERE id = $1
          `, { bind: [job.id, String(error.message), newRetryCount] })
        }
      }
    } catch (error) {
      logger.error('Worker error', error)
    } finally {
      processing = false
    }
  }, 30000)

  logger.info('Background worker started (30s polling)')
}

/**
 * Start periodic sync timer
 * Checks every 5 minutes if sync_interval has elapsed, then re-fetches all segments
 */
function startSyncTimer(peertubeHelpers, settingsManager) {
  const logger = peertubeHelpers.logger
  const database = peertubeHelpers.database
  const CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes

  syncIntervalId = setInterval(async () => {
    try {
      const intervalHours = parseFloat(await settingsManager.getSetting('sync_interval')) || 0
      if (intervalHours <= 0) return

      const intervalMs = intervalHours * 3600 * 1000
      const now = Date.now()

      if (lastSyncCheck > 0 && (now - lastSyncCheck) < intervalMs) return

      lastSyncCheck = now
      logger.info('Periodic sync: starting')

      const [mappings] = await database.query(
        'SELECT peertube_uuid, youtube_id FROM plugin_sponsorblock_mapping'
      )

      const apiUrl = await settingsManager.getSetting('api_url') || 'https://sponsor.ajay.app'
      validateApiUrl(apiUrl)

      for (const mapping of (mappings || [])) {
        try {
          const response = await fetch(`${apiUrl}/api/skipSegments?videoID=${mapping.youtube_id}${CATEGORIES_PARAM}`)

          if (response.ok) {
            const apiSegments = await response.json()

            await database.query('BEGIN')
            try {
              await database.query(
                'DELETE FROM plugin_sponsorblock_segments WHERE youtube_id = $1',
                { bind: [mapping.youtube_id] }
              )

              for (const segment of apiSegments) {
                if (!validateSegment(segment)) {
                  logger.warn(`Periodic sync: skipping invalid segment: ${JSON.stringify(segment).slice(0, 200)}`)
                  continue
                }
                await database.query(`
                  INSERT INTO plugin_sponsorblock_segments
                  (youtube_id, segment_uuid, start_time, end_time, category, action_type, votes)
                  VALUES ($1, $2, $3, $4, $5, $6, $7)
                  ON CONFLICT (segment_uuid) DO NOTHING
                `, { bind: [
                  mapping.youtube_id,
                  segment.UUID,
                  segment.segment[0],
                  segment.segment[1],
                  segment.category,
                  segment.actionType || 'skip',
                  segment.votes || 0
                ] })
              }

              await database.query('COMMIT')
            } catch (txError) {
              await database.query('ROLLBACK')
              throw txError
            }
          }

          await database.query(
            'UPDATE plugin_sponsorblock_mapping SET last_sync = NOW() WHERE peertube_uuid = $1',
            { bind: [mapping.peertube_uuid] }
          )
        } catch (err) {
          logger.error(`Periodic sync: failed for ${mapping.youtube_id}`, err)
        }

        // Rate limit: 200ms between requests
        await new Promise(resolve => setTimeout(resolve, 200))
      }

      logger.info(`Periodic sync: complete (${(mappings || []).length} mappings)`)
    } catch (error) {
      logger.error('Periodic sync error', error)
    }
  }, CHECK_INTERVAL)

  logger.info('Periodic sync timer started (5-min check interval)')
}

module.exports = {
  register,
  unregister
}
