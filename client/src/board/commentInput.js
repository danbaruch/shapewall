// Shared by the thread's reply and edit boxes and the new-comment composer.

export const COMMENT_MAX = 2000

// Enter sends; Shift+Enter is a new line. On touch keyboards Enter stays a
// new line (there is a send button), like chat apps.
export const sendsOnEnter = (event, touch) => event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !touch
