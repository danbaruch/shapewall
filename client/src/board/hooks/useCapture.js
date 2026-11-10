import { useState } from 'react'
import { api } from '../../lib/api'

// "Capture now": the confirm dialog's state and the request. `env` captures
// one environment, `pages` only those pages; neither: the whole board.
export function useCapture({ boardId, view, setBusy, setNotice, setPolling }) {
  const [captureConfirm, setCaptureConfirm] = useState(false)
  const startCapture = async (env = null, pages = null) => {
    setBusy(true)
    try {
      const result = await api.post(`/api/boards/${encodeURIComponent(boardId)}/capture`, {
        ...(env ? { env } : {}),
        ...(pages ? { pages } : {}),
      })
      setNotice({ tone: 'info', text: result.message || 'Capture started.' })
      setPolling(true)
      view.refetch()
    } catch (error) {
      setNotice({ tone: 'bad', text: error.message || 'The capture did not start.' })
    } finally {
      setBusy(false)
      setCaptureConfirm(false)
    }
  }
  return { captureConfirm, setCaptureConfirm, startCapture }
}
