/**
 * Server-side API routes
 */

async function registerRoutes({ router, peertubeHelpers }) {
  const logger = peertubeHelpers.logger

  /**
   * GET /segments/:videoUuid
   * Returns SponsorBlock segments for a given video
   */
  router.get('/segments/:videoUuid', async (req, res) => {
    const videoUuid = req.params.videoUuid

    try {
      const database = peertubeHelpers.database

      // Get YouTube ID for this video
      const [mappings] = await database.query(`
        SELECT youtube_id FROM plugin_sponsorblock_mapping
        WHERE peertube_uuid = $1
      `, [videoUuid])

      if (!mappings || mappings.length === 0) {
        return res.status(404).json({
          error: 'No YouTube mapping found for this video',
          segments: []
        })
      }

      const youtubeId = mappings[0].youtube_id

      // Get segments
      const [segments] = await database.query(`
        SELECT
          segment_uuid,
          start_time,
          end_time,
          category,
          action_type,
          votes
        FROM plugin_sponsorblock_segments
        WHERE youtube_id = $1
        ORDER BY start_time ASC
      `, [youtubeId])

      res.json({
        videoUuid,
        youtubeId,
        segments: segments || []
      })

    } catch (error) {
      logger.error('Error fetching segments', error)
      res.status(500).json({
        error: 'Internal server error',
        segments: []
      })
    }
  })

  /**
   * GET /mapping/:videoUuid
   * Returns YouTube ID mapping for a video
   */
  router.get('/mapping/:videoUuid', async (req, res) => {
    const videoUuid = req.params.videoUuid

    try {
      const database = peertubeHelpers.database

      const [mappings] = await database.query(`
        SELECT youtube_id, created_at, last_sync
        FROM plugin_sponsorblock_mapping
        WHERE peertube_uuid = $1
      `, [videoUuid])

      if (!mappings || mappings.length === 0) {
        return res.status(404).json({
          error: 'No YouTube mapping found'
        })
      }

      res.json(mappings[0])

    } catch (error) {
      logger.error('Error fetching mapping', error)
      res.status(500).json({
        error: 'Internal server error'
      })
    }
  })

  /**
   * POST /sync/:videoUuid
   * Manually trigger sync for a video
   */
  router.post('/sync/:videoUuid', async (req, res) => {
    const videoUuid = req.params.videoUuid

    try {
      const database = peertubeHelpers.database

      // Get YouTube ID
      const [mappings] = await database.query(`
        SELECT youtube_id FROM plugin_sponsorblock_mapping
        WHERE peertube_uuid = $1
      `, [videoUuid])

      if (!mappings || mappings.length === 0) {
        return res.status(404).json({
          error: 'No YouTube mapping found'
        })
      }

      const youtubeId = mappings[0].youtube_id

      // Fetch fresh segments
      const apiUrl = 'https://sponsor.ajay.app'
      const response = await fetch(`${apiUrl}/api/skipSegments?videoID=${youtubeId}`)

      if (!response.ok) {
        return res.status(response.status).json({
          error: 'Failed to fetch from SponsorBlock API'
        })
      }

      const segments = await response.json()

      // Delete old segments
      await database.query(`
        DELETE FROM plugin_sponsorblock_segments WHERE youtube_id = $1
      `, [youtubeId])

      // Insert new segments
      let insertedCount = 0
      for (const segment of segments) {
        await database.query(`
          INSERT INTO plugin_sponsorblock_segments
          (youtube_id, segment_uuid, start_time, end_time, category, action_type, votes)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (segment_uuid) DO NOTHING
        `, [
          youtubeId,
          segment.UUID,
          segment.segment[0],
          segment.segment[1],
          segment.category,
          segment.actionType || 'skip',
          segment.votes || 0
        ])
        insertedCount++
      }

      // Update last_sync timestamp
      await database.query(`
        UPDATE plugin_sponsorblock_mapping
        SET last_sync = NOW()
        WHERE peertube_uuid = $1
      `, [videoUuid])

      logger.info(`Synced ${insertedCount} segments for ${videoUuid}`)

      res.json({
        success: true,
        segmentsCount: insertedCount,
        youtubeId
      })

    } catch (error) {
      logger.error('Error syncing segments', error)
      res.status(500).json({
        error: 'Internal server error'
      })
    }
  })
}

module.exports = { registerRoutes }
