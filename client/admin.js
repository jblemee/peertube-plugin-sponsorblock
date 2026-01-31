/**
 * Admin dashboard client script
 * Scope: admin-plugin
 */

function register({ registerHook, peertubeHelpers }) {
  registerHook({
    target: 'action:admin-plugin-settings.init',
    handler: ({ npmName }) => {
      if (npmName !== 'peertube-plugin-sponsorblock') return
      initDashboard(peertubeHelpers)
    }
  })
}

function findOrCreateContainer() {
  // Try the html setting container first
  const existing = document.getElementById('sponsorblock-admin-dashboard')
  if (existing) return existing

  // Fallback: find the settings form and inject before it
  const form = document.querySelector('my-plugin-show-installed form')
    || document.querySelector('.plugin-show-installed form')
    || document.querySelector('form')

  if (!form) return null

  const container = document.createElement('div')
  container.id = 'sponsorblock-admin-dashboard'
  form.parentNode.insertBefore(container, form.nextSibling)
  return container
}

async function initDashboard(peertubeHelpers) {
  // Wait a tick for Angular to finish rendering
  await new Promise(resolve => setTimeout(resolve, 100))

  const container = findOrCreateContainer()
  if (!container) {
    console.error('[SponsorBlock] Could not find or create dashboard container')
    return
  }

  const baseUrl = peertubeHelpers.getBaseRouterRoute()
  const t = (key) => peertubeHelpers.translate(key)

  const root = document.createElement('div')
  root.className = 'sponsorblock-admin-root'
  container.appendChild(root)

  // Stats row
  const statsRow = document.createElement('div')
  statsRow.className = 'sponsorblock-admin-stats'
  root.appendChild(statsRow)

  const statCards = [
    { id: 'mapped', key: 'admin-stats-mapped', value: '—' },
    { id: 'segments', key: 'admin-stats-segments', value: '—' },
    { id: 'time', key: 'admin-stats-time-saved', value: '—' },
    { id: 'queue', key: 'admin-stats-queue', value: '—' }
  ]

  for (const card of statCards) {
    const el = document.createElement('div')
    el.className = 'sponsorblock-admin-stat'
    const valEl = document.createElement('div')
    valEl.className = 'sponsorblock-admin-stat-value'
    valEl.id = `sponsorblock-stat-${card.id}`
    valEl.textContent = card.value
    const labelEl = document.createElement('div')
    labelEl.className = 'sponsorblock-admin-stat-label'
    labelEl.textContent = await t(card.key) || card.key
    el.appendChild(valEl)
    el.appendChild(labelEl)
    statsRow.appendChild(el)
  }

  // Action buttons
  const actionsRow = document.createElement('div')
  actionsRow.className = 'sponsorblock-admin-actions'
  root.appendChild(actionsRow)

  const scanBtn = await createButton(t, 'admin-btn-scan', 'sponsorblock-admin-btn')
  scanBtn.title = await t('admin-btn-scan-desc') || 'Scan the video import table for YouTube URLs and create mappings for new videos'
  const syncAllBtn = await createButton(t, 'admin-btn-sync-all', 'sponsorblock-admin-btn sponsorblock-admin-btn--secondary')
  syncAllBtn.title = await t('admin-btn-sync-all-desc') || 'Re-fetch SponsorBlock segments for all mapped videos'
  const processAllBtn = await createButton(t, 'admin-btn-process-all', 'sponsorblock-admin-btn sponsorblock-admin-btn--secondary')
  processAllBtn.title = await t('admin-btn-process-all-desc') || 'Queue all mapped videos for permanent segment removal (requires FFmpeg)'

  actionsRow.appendChild(scanBtn)
  actionsRow.appendChild(syncAllBtn)
  actionsRow.appendChild(processAllBtn)

  // Status message area
  const messageEl = document.createElement('div')
  messageEl.className = 'sponsorblock-admin-message'
  messageEl.style.display = 'none'
  root.appendChild(messageEl)

  // Mappings table
  const tableWrap = document.createElement('div')
  tableWrap.className = 'sponsorblock-admin-table-wrap'
  root.appendChild(tableWrap)

  // Load data
  await refreshStats(baseUrl, peertubeHelpers)
  await refreshTable(baseUrl, peertubeHelpers, t, tableWrap, messageEl)

  // Button handlers
  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true
    showMessage(messageEl, await t('admin-scan-started') || 'Scanning…', 'success')

    try {
      const resp = await apiFetch(baseUrl, '/scan', peertubeHelpers, { method: 'POST' })
      const data = await resp.json()
      const msg = (await t('admin-scan-result') || 'Scanned {scanned}, mapped {mapped} new video(s).')
        .replace('{scanned}', data.scanned)
        .replace('{mapped}', data.mapped)
      showMessage(messageEl, msg, 'success')
      await refreshStats(baseUrl, peertubeHelpers)
      await refreshTable(baseUrl, peertubeHelpers, t, tableWrap, messageEl)
    } catch (err) {
      showMessage(messageEl, err.message, 'error')
    } finally {
      scanBtn.disabled = false
    }
  })

  syncAllBtn.addEventListener('click', async () => {
    syncAllBtn.disabled = true

    try {
      const resp = await apiFetch(baseUrl, '/sync-all', peertubeHelpers, { method: 'POST' })
      const data = await resp.json()
      const msg = (await t('admin-sync-started') || 'Syncing all mappings ({total})…')
        .replace('{total}', data.total)
      showMessage(messageEl, msg, 'success')
      // Refresh after a short delay to let background sync start
      setTimeout(async () => {
        await refreshStats(baseUrl, peertubeHelpers)
        await refreshTable(baseUrl, peertubeHelpers, t, tableWrap, messageEl)
      }, 2000)
    } catch (err) {
      showMessage(messageEl, err.message, 'error')
    } finally {
      syncAllBtn.disabled = false
    }
  })

  processAllBtn.addEventListener('click', async () => {
    processAllBtn.disabled = true

    try {
      const resp = await apiFetch(baseUrl, '/process-all', peertubeHelpers, { method: 'POST' })
      const data = await resp.json()
      const msg = (await t('admin-process-result') || 'Queued {queued} video(s) for processing.')
        .replace('{queued}', data.queued)
      showMessage(messageEl, msg, 'success')
      await refreshStats(baseUrl, peertubeHelpers)
      await refreshTable(baseUrl, peertubeHelpers, t, tableWrap, messageEl)
    } catch (err) {
      showMessage(messageEl, err.message, 'error')
    } finally {
      processAllBtn.disabled = false
    }
  })
}

/**
 * Fetch and update stats cards
 */
async function refreshStats(baseUrl, peertubeHelpers) {
  try {
    const resp = await apiFetch(baseUrl, '/admin/stats', peertubeHelpers)
    const data = await resp.json()

    setText('sponsorblock-stat-mapped', data.mapped_videos)
    setText('sponsorblock-stat-segments', data.total_segments)
    setText('sponsorblock-stat-time', formatDuration(data.total_time_saved))
    setText('sponsorblock-stat-queue', data.queue.pending)
  } catch (err) {
    console.error('[SponsorBlock] Failed to load stats:', err)
  }
}

/**
 * Fetch and render mappings table
 */
async function refreshTable(baseUrl, peertubeHelpers, t, tableWrap, messageEl) {
  try {
    const resp = await apiFetch(baseUrl, '/admin/mappings', peertubeHelpers)
    const data = await resp.json()
    const mappings = data.mappings || []

    tableWrap.innerHTML = ''

    if (mappings.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'sponsorblock-admin-empty'
      empty.textContent = await t('admin-no-mappings') || 'No mappings yet.'
      tableWrap.appendChild(empty)
      return
    }

    const table = document.createElement('table')
    table.className = 'sponsorblock-admin-table'

    // Header
    const thead = document.createElement('thead')
    const headerRow = document.createElement('tr')
    const headers = [
      'admin-table-video', 'admin-table-youtube', 'admin-table-segments',
      'admin-table-saved', 'admin-table-synced', 'admin-table-queue', 'admin-table-actions'
    ]
    for (const key of headers) {
      const th = document.createElement('th')
      th.textContent = await t(key) || key
      headerRow.appendChild(th)
    }
    thead.appendChild(headerRow)
    table.appendChild(thead)

    // Body
    const tbody = document.createElement('tbody')
    for (const mapping of mappings) {
      const tr = document.createElement('tr')

      // Video name
      const tdVideo = document.createElement('td')
      if (mapping.video_name) {
        const link = document.createElement('a')
        link.href = `/w/${mapping.peertube_uuid}`
        link.textContent = mapping.video_name
        link.title = mapping.peertube_uuid
        link.target = '_blank'
        tdVideo.appendChild(link)
      } else {
        const uuidCode = document.createElement('code')
        uuidCode.textContent = mapping.peertube_uuid
        tdVideo.appendChild(uuidCode)
      }
      tr.appendChild(tdVideo)

      // YouTube ID
      const tdYt = document.createElement('td')
      const ytCode = document.createElement('code')
      ytCode.textContent = mapping.youtube_id
      tdYt.appendChild(ytCode)
      tr.appendChild(tdYt)

      // Segments count
      const tdSeg = document.createElement('td')
      tdSeg.textContent = mapping.segment_count
      tr.appendChild(tdSeg)

      // Time saved
      const tdTime = document.createElement('td')
      tdTime.textContent = formatDuration(mapping.time_saved)
      tr.appendChild(tdTime)

      // Last sync
      const tdSync = document.createElement('td')
      if (mapping.last_sync) {
        tdSync.textContent = formatRelativeTime(mapping.last_sync)
        tdSync.title = new Date(mapping.last_sync).toLocaleString()
      } else {
        tdSync.textContent = await t('admin-last-sync-never') || 'Never'
      }
      tr.appendChild(tdSync)

      // Queue status
      const tdQueue = document.createElement('td')
      if (mapping.queue_status) {
        const badge = document.createElement('span')
        badge.className = `sponsorblock-admin-badge sponsorblock-admin-badge--${mapping.queue_status}`
        const queueKey = `admin-queue-${mapping.queue_status}`
        badge.textContent = await t(queueKey) || mapping.queue_status
        if (mapping.queue_error) badge.title = mapping.queue_error
        tdQueue.appendChild(badge)
      } else {
        tdQueue.textContent = '—'
      }
      tr.appendChild(tdQueue)

      // Actions
      const tdActions = document.createElement('td')
      const actionsDiv = document.createElement('div')
      actionsDiv.className = 'sponsorblock-admin-row-actions'

      const syncBtn = document.createElement('button')
      syncBtn.className = 'sponsorblock-admin-row-btn sponsorblock-admin-row-btn--sync'
      syncBtn.textContent = await t('admin-action-sync') || 'Sync'
      syncBtn.addEventListener('click', async () => {
        syncBtn.disabled = true
        try {
          await apiFetch(baseUrl, `/sync/${mapping.peertube_uuid}`, peertubeHelpers, { method: 'POST' })
          await refreshStats(baseUrl, peertubeHelpers)
          await refreshTable(baseUrl, peertubeHelpers, t, tableWrap, messageEl)
        } catch (err) {
          showMessage(messageEl, err.message, 'error')
        } finally {
          syncBtn.disabled = false
        }
      })

      const processBtn = document.createElement('button')
      processBtn.className = 'sponsorblock-admin-row-btn sponsorblock-admin-row-btn--process'
      processBtn.textContent = await t('admin-action-process') || 'Process'
      processBtn.addEventListener('click', async () => {
        processBtn.disabled = true
        try {
          await apiFetch(baseUrl, `/process/${mapping.peertube_uuid}`, peertubeHelpers, { method: 'POST' })
          await refreshStats(baseUrl, peertubeHelpers)
          await refreshTable(baseUrl, peertubeHelpers, t, tableWrap, messageEl)
        } catch (err) {
          showMessage(messageEl, err.message, 'error')
        } finally {
          processBtn.disabled = false
        }
      })

      const deleteBtn = document.createElement('button')
      deleteBtn.className = 'sponsorblock-admin-row-btn sponsorblock-admin-row-btn--delete'
      deleteBtn.textContent = await t('admin-action-delete') || 'Delete'
      deleteBtn.addEventListener('click', async () => {
        const confirmMsg = await t('admin-delete-confirm') || 'Delete mapping for this video?'
        if (!confirm(confirmMsg)) return

        deleteBtn.disabled = true
        try {
          await apiFetch(baseUrl, `/mapping/${mapping.peertube_uuid}`, peertubeHelpers, { method: 'DELETE' })
          showMessage(messageEl, await t('admin-delete-success') || 'Mapping deleted.', 'success')
          await refreshStats(baseUrl, peertubeHelpers)
          await refreshTable(baseUrl, peertubeHelpers, t, tableWrap, messageEl)
        } catch (err) {
          showMessage(messageEl, err.message, 'error')
        } finally {
          deleteBtn.disabled = false
        }
      })

      actionsDiv.appendChild(syncBtn)
      actionsDiv.appendChild(processBtn)
      actionsDiv.appendChild(deleteBtn)
      tdActions.appendChild(actionsDiv)
      tr.appendChild(tdActions)

      tbody.appendChild(tr)
    }

    table.appendChild(tbody)
    tableWrap.appendChild(table)
  } catch (err) {
    console.error('[SponsorBlock] Failed to load mappings:', err)
  }
}

/**
 * Helper: API fetch with auth
 */
async function apiFetch(baseUrl, path, peertubeHelpers, options = {}) {
  const resp = await fetch(baseUrl + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...peertubeHelpers.getAuthHeader(),
      ...(options.headers || {})
    }
  })

  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    throw new Error(data.error || `HTTP ${resp.status}`)
  }

  return resp
}

/**
 * Helper: Create a translated button
 */
async function createButton(t, key, className) {
  const btn = document.createElement('button')
  btn.className = className
  btn.textContent = await t(key) || key
  return btn
}

/**
 * Helper: Set text content by ID
 */
function setText(id, value) {
  const el = document.getElementById(id)
  if (el) el.textContent = value
}

/**
 * Helper: Format seconds as human-readable duration
 */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0s'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`
  const h = Math.floor(m / 60)
  const remM = m % 60
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`
}

/**
 * Helper: Format ISO date as relative time
 */
function formatRelativeTime(isoDate) {
  const diff = Date.now() - new Date(isoDate).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return '<1m ago'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/**
 * Helper: Show status message
 */
function showMessage(el, text, type) {
  el.textContent = text
  el.className = `sponsorblock-admin-message sponsorblock-admin-message--${type}`
  el.style.display = 'block'
  setTimeout(() => { el.style.display = 'none' }, 8000)
}

export { register }
