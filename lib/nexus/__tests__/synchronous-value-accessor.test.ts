import { createSynchronousValueAccessor } from '../synchronous-value-accessor'

describe('createSynchronousValueAccessor', () => {
  it('keeps stable accessors while exposing the latest assigned value', () => {
    const accessor = createSynchronousValueAccessor({
      conversationId: null as string | null,
      workspaceId: undefined as string | undefined,
    })
    const get = accessor.get

    accessor.set({
      conversationId: 'conversation-1',
      workspaceId: 'workspace-1',
    })

    expect(accessor.get).toBe(get)
    expect(get()).toEqual({
      conversationId: 'conversation-1',
      workspaceId: 'workspace-1',
    })
  })
})
