/**
 * Client-side code for video watch page
 * Implements automatic segment skipping
 */

function register({ registerHook, peertubeHelpers }) {
  console.log('[SponsorBlock] Video watch script loaded')

  let segments = []
  let skippedSegments = new Set()
  let currentVideo = null

  // Hook: When video is loaded
  registerHook({
    target: 'action:video-watch.video.loaded',
    handler: async ({ video, videojs }) => {
      console.log('[SponsorBlock] Video loaded:', video.uuid)

      currentVideo = video
      segments = []
      skippedSegments.clear()

      try {
        // Fetch segments for this video
        segments = await fetchSegments(video.uuid)

        if (segments.length > 0) {
          console.log(`[SponsorBlock] Found ${segments.length} segments to skip`)
          setupSegmentSkipping(videojs)
        } else {
          console.log('[SponsorBlock] No segments found for this video')
        }
      } catch (error) {
        console.error('[SponsorBlock] Failed to fetch segments:', error)
      }
    }
  })

  /**
   * Fetch segments from server
   */
  async function fetchSegments(videoUuid) {
    try {
      const baseUrl = window.location.origin
      const response = await fetch(
        `${baseUrl}/plugins/sponsorblock/router/segments/${videoUuid}`,
        {
          method: 'GET',
          headers: peertubeHelpers.getAuthHeader()
        }
      )

      if (!response.ok) {
        if (response.status === 404) {
          return [] // No segments found
        }
        throw new Error(`Failed to fetch segments: ${response.status}`)
      }

      const data = await response.json()
      return data.segments || []
    } catch (error) {
      console.error('[SponsorBlock] Error fetching segments:', error)
      return []
    }
  }

  /**
   * Setup segment skipping on the video player
   */
  function setupSegmentSkipping(player) {
    if (!player) return

    let lastCheckTime = 0

    player.on('timeupdate', () => {
      const currentTime = player.currentTime()

      // Throttle checks to avoid performance issues
      if (Math.abs(currentTime - lastCheckTime) < 0.5) {
        return
      }
      lastCheckTime = currentTime

      // Check if we're in a segment to skip
      for (const segment of segments) {
        const segmentKey = `${segment.start_time}-${segment.end_time}`

        if (currentTime >= segment.start_time && currentTime < segment.end_time) {
          // Skip this segment if not already skipped
          if (!skippedSegments.has(segmentKey)) {
            console.log(`[SponsorBlock] Skipping ${segment.category} segment: ${segment.start_time}s - ${segment.end_time}s`)

            player.currentTime(segment.end_time)
            skippedSegments.add(segmentKey)

            // Show notification
            showSkipNotification(segment)
          }
          break
        }
      }
    })

    // Add visual indicators to the progress bar
    addProgressBarMarkers(player)
  }

  /**
   * Show notification when a segment is skipped
   */
  function showSkipNotification(segment) {
    const categoryLabels = {
      sponsor: 'Sponsor',
      selfpromo: 'Self-promotion',
      interaction: 'Interaction reminder',
      intro: 'Intro',
      outro: 'Outro',
      preview: 'Preview',
      music_offtopic: 'Off-topic music',
      filler: 'Filler'
    }

    const label = categoryLabels[segment.category] || segment.category
    const duration = (segment.end_time - segment.start_time).toFixed(1)

    peertubeHelpers.notifier.info(
      `Skipped ${label} (${duration}s)`,
      'SponsorBlock',
      3000
    )
  }

  /**
   * Add visual markers to the progress bar
   */
  function addProgressBarMarkers(player) {
    if (!player || segments.length === 0) return

    try {
      const progressControl = player.controlBar.progressControl
      if (!progressControl) return

      const seekBar = progressControl.seekBar
      if (!seekBar) return

      const duration = player.duration()
      if (!duration || duration === Infinity) {
        // Wait for duration to be available
        player.one('durationchange', () => addProgressBarMarkers(player))
        return
      }

      // Remove existing markers
      const existingMarkers = seekBar.el().querySelectorAll('.sponsorblock-marker')
      existingMarkers.forEach(marker => marker.remove())

      // Add markers for each segment
      segments.forEach(segment => {
        const startPercent = (segment.start_time / duration) * 100
        const widthPercent = ((segment.end_time - segment.start_time) / duration) * 100

        const marker = document.createElement('div')
        marker.className = 'sponsorblock-marker'
        marker.style.cssText = `
          position: absolute;
          left: ${startPercent}%;
          width: ${widthPercent}%;
          height: 100%;
          background-color: rgba(0, 255, 0, 0.6);
          pointer-events: none;
          z-index: 30;
        `
        marker.title = `${segment.category}: ${segment.start_time}s - ${segment.end_time}s`

        seekBar.el().appendChild(marker)
      })

      console.log(`[SponsorBlock] Added ${segments.length} progress bar markers`)
    } catch (error) {
      console.error('[SponsorBlock] Failed to add progress bar markers:', error)
    }
  }
}

export { register }
