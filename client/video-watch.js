/**
 * Client-side code for video watch page
 * Implements automatic segment skipping
 */

function register({ registerHook, peertubeHelpers }) {
  console.log('[SponsorBlock] Video watch script loaded');

  let segments = [];
  const skippedSegments = new Set();
  let skippingActive = false;
  let playerRef = null;
  let currentTimeUpdateHandler = null;
  let currentVideoEl = null;
  let showNotifications = true;

  // Hook: When video is loaded
  registerHook({
    target: 'action:video-watch.video.loaded',
    handler: async ({ video, videojs }) => {
      console.log('[SponsorBlock] Video loaded:', video.uuid);

      // Clean up previous listeners
      if (currentVideoEl && currentTimeUpdateHandler) {
        currentVideoEl.removeEventListener('timeupdate', currentTimeUpdateHandler);
        currentTimeUpdateHandler = null;
        currentVideoEl = null;
      }

      segments = [];
      skippedSegments.clear();
      skippingActive = false;
      playerRef = videojs;

      // Read show_notifications setting
      try {
        const settings = await peertubeHelpers.getSettings();
        showNotifications = settings['show_notifications'] !== false && settings['show_notifications'] !== 'false';
      } catch {
        showNotifications = true;
      }

      try {
        // Fetch segments for this video
        segments = await fetchSegments(video.uuid);

        if (segments.length > 0) {
          console.log(`[SponsorBlock] Found ${segments.length} segments to skip`);
          setupSegmentSkipping(videojs);
        } else {
          console.log('[SponsorBlock] No segments found for this video');
        }
      } catch (error) {
        console.error('[SponsorBlock] Failed to fetch segments:', error);
      }

      // Show mapping widget for admins/moderators
      try {
        const user = await peertubeHelpers.getUser();
        if (user && (user.role === 0 || user.role === 1)) {
          renderMappingWidget(video.uuid);
        }
      } catch (e) {
        // Not logged in or can't get user — skip widget
      }
    }
  });

  /**
   * Fetch segments from server
   */
  async function fetchSegments(videoUuid) {
    try {
      const baseUrl = window.location.origin;
      const response = await fetch(
        `${baseUrl}/plugins/sponsorblock/router/segments/${videoUuid}`,
        {
          method: 'GET',
          headers: peertubeHelpers.getAuthHeader()
        }
      );

      if (!response.ok) {
        if (response.status === 404) {
          return []; // No segments found
        }
        throw new Error(`Failed to fetch segments: ${response.status}`);
      }

      const data = await response.json();
      return data.segments || [];
    } catch (error) {
      console.error('[SponsorBlock] Error fetching segments:', error);
      return [];
    }
  }

  /**
   * Setup segment skipping on the video player
   */
  function setupSegmentSkipping(player) {
    if (!player) return;

    // Avoid doubling listeners if skipping was already set up
    if (skippingActive) return;
    skippingActive = true;

    // Access the native HTML5 <video> element (PeerTube v8 wraps Video.js)
    const videoEl = player.el
      ? player.el().querySelector('video')
      : document.querySelector('.vjs-tech');

    if (!videoEl) {
      console.error('[SponsorBlock] Could not find video element');
      return;
    }

    let lastCheckTime = 0;

    currentTimeUpdateHandler = () => {
      const currentTime = videoEl.currentTime;

      // Throttle checks to avoid performance issues
      if (Math.abs(currentTime - lastCheckTime) < 0.5) {
        return;
      }
      lastCheckTime = currentTime;

      // Check if we're in a segment to skip
      for (const segment of segments) {
        const segmentKey = `${segment.start_time}-${segment.end_time}`;

        if (currentTime >= segment.start_time && currentTime < segment.end_time) {
          // Skip this segment if not already skipped
          if (!skippedSegments.has(segmentKey)) {
            console.log(`[SponsorBlock] Skipping ${segment.category} segment: ${segment.start_time}s - ${segment.end_time}s`);

            videoEl.currentTime = segment.end_time;
            skippedSegments.add(segmentKey);

            if (showNotifications) {
              showSkipNotification(segment);
            }
          }
          break;
        }
      }
    };

    currentVideoEl = videoEl;
    videoEl.addEventListener('timeupdate', currentTimeUpdateHandler);

    // Add visual indicators to the progress bar
    addProgressBarMarkers(player);
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
    };

    const label = categoryLabels[segment.category] || segment.category;
    const duration = (segment.end_time - segment.start_time).toFixed(1);

    peertubeHelpers.notifier.info(
      `Skipped ${label} (${duration}s)`,
      'SponsorBlock',
      3000
    );
  }

  /**
   * Render the mapping widget for admins/moderators
   */
  async function renderMappingWidget(videoUuid) {
    // Remove any existing widget
    const existing = document.querySelector('.sponsorblock-widget');
    if (existing) existing.remove();

    // Find the container below the player
    const container = document.querySelector('.video-info');
    if (!container) return;

    const widget = document.createElement('div');
    widget.className = 'sponsorblock-widget';

    // Check for existing mapping
    let currentMapping = null;
    try {
      const baseUrl = window.location.origin;
      const resp = await fetch(
        `${baseUrl}/plugins/sponsorblock/router/mapping/${videoUuid}`,
        { headers: peertubeHelpers.getAuthHeader() }
      );
      if (resp.ok) {
        currentMapping = await resp.json();
      }
    } catch (e) {
      // No mapping yet
    }

    const translate = (key) => peertubeHelpers.translate(key);

    const label = await translate('mapping-label') || 'SponsorBlock';
    const placeholder = await translate('mapping-placeholder') || 'YouTube ID or URL';
    const linkBtn = await translate('mapping-link-btn') || 'Link';
    const currentLabel = await translate('mapping-current') || 'Linked to:';

    // Build toggle label
    const toggle = document.createElement('span');
    toggle.className = 'sponsorblock-widget-toggle';
    toggle.textContent = `▶ ${label}`;
    widget.appendChild(toggle);

    // Collapsible content
    const content = document.createElement('div');
    content.style.display = 'none';

    // Show current mapping if any
    const currentDiv = document.createElement('div');
    currentDiv.className = 'sponsorblock-widget-current';
    if (currentMapping) {
      currentDiv.textContent = '';
      currentDiv.appendChild(document.createTextNode(currentLabel + ' '));
      const code = document.createElement('code');
      code.textContent = currentMapping.youtube_id;
      currentDiv.appendChild(code);
    }
    content.appendChild(currentDiv);

    // Form row
    const form = document.createElement('div');
    form.className = 'sponsorblock-widget-form';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sponsorblock-widget-input';
    input.placeholder = placeholder;
    form.appendChild(input);

    const btn = document.createElement('button');
    btn.className = 'sponsorblock-widget-btn';
    btn.textContent = linkBtn;
    form.appendChild(btn);

    content.appendChild(form);

    // Status message
    const status = document.createElement('div');
    status.className = 'sponsorblock-widget-status';
    content.appendChild(status);

    widget.appendChild(content);

    // Toggle open/close
    toggle.addEventListener('click', () => {
      const open = content.style.display !== 'none';
      content.style.display = open ? 'none' : 'block';
      toggle.textContent = `${open ? '▶' : '▼'} ${label}`;
    });

    // Submit mapping
    btn.addEventListener('click', async () => {
      const value = input.value.trim();
      if (!value) return;

      btn.disabled = true;
      status.textContent = '';
      status.className = 'sponsorblock-widget-status';

      try {
        const baseUrl = window.location.origin;
        const resp = await fetch(
          `${baseUrl}/plugins/sponsorblock/router/mapping/${videoUuid}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...peertubeHelpers.getAuthHeader()
            },
            body: JSON.stringify({ youtubeId: value })
          }
        );

        const data = await resp.json();

        if (!resp.ok) {
          const errorMsg = data.error === 'Invalid YouTube ID format'
            ? (await translate('mapping-invalid-id') || 'Invalid YouTube ID.')
            : (await translate('mapping-error') || 'Error linking video.');
          status.textContent = errorMsg;
          status.classList.add('error');
          return;
        }

        // Update segments and activate skipping
        segments = data.segments || [];
        skippedSegments.clear();

        if (segments.length > 0) {
          const successMsg = (await translate('mapping-success') || 'Linked! {count} segment(s) found.')
            .replace('{count}', segments.length);
          status.textContent = successMsg;
          status.classList.add('success');

          if (playerRef) {
            setupSegmentSkipping(playerRef);
            addProgressBarMarkers(playerRef);
          }
        } else {
          status.textContent = await translate('mapping-no-segments') || 'Linked, but no segments found on SponsorBlock.';
          status.classList.add('success');
        }

        // Update current mapping display
        currentDiv.textContent = '';
        currentDiv.appendChild(document.createTextNode(currentLabel + ' '));
        const codeEl = document.createElement('code');
        codeEl.textContent = data.youtubeId;
        currentDiv.appendChild(codeEl);
        input.value = '';

      } catch (e) {
        status.textContent = await translate('mapping-error') || 'Error linking video.';
        status.classList.add('error');
      } finally {
        btn.disabled = false;
      }
    });

    // Allow Enter key to submit
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btn.click();
    });

    container.prepend(widget);
  }

  /**
   * Add visual markers to the progress bar
   */
  function addProgressBarMarkers(player) {
    if (!player || segments.length === 0) return;

    try {
      // Access seek bar element with fallback for PeerTube v8 wrapper
      let seekBarEl;
      try {
        seekBarEl = player.controlBar.progressControl.seekBar.el();
      } catch {
        seekBarEl = document.querySelector('.vjs-progress-holder');
      }
      if (!seekBarEl) return;

      // Access the native HTML5 <video> element for duration
      const videoEl = player.el
        ? player.el().querySelector('video')
        : document.querySelector('.vjs-tech');
      if (!videoEl) return;

      const duration = videoEl.duration;
      if (!duration || duration === Infinity || isNaN(duration)) {
        // Wait for duration to be available
        videoEl.addEventListener('durationchange', () => addProgressBarMarkers(player), { once: true });
        return;
      }

      // Remove existing markers
      const existingMarkers = seekBarEl.querySelectorAll('.sponsorblock-marker');
      existingMarkers.forEach(marker => marker.remove());

      // Add markers for each segment
      segments.forEach(segment => {
        const startPercent = (segment.start_time / duration) * 100;
        const widthPercent = ((segment.end_time - segment.start_time) / duration) * 100;

        const marker = document.createElement('div');
        marker.className = 'sponsorblock-marker';
        marker.dataset.category = segment.category;
        marker.style.cssText = `
          position: absolute;
          top: 0;
          bottom: 0;
          left: ${startPercent}%;
          width: ${widthPercent}%;
          pointer-events: none;
          z-index: 30;
        `;
        marker.title = `${segment.category}: ${segment.start_time}s - ${segment.end_time}s`;

        seekBarEl.appendChild(marker);
      });

      console.log(`[SponsorBlock] Added ${segments.length} progress bar markers`);
    } catch (error) {
      console.error('[SponsorBlock] Failed to add progress bar markers:', error);
    }
  }
}

export { register };
