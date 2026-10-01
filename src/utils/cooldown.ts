export class ActivationCooldown {
  private users = new Map<string, number>()
  private channels = new Map<string, number>()

  constructor(
    private userMs: number,
    private channelMs: number
  ) {
    if (![userMs, channelMs].every((n) => Number.isFinite(n) && n >= 0 && n <= 60_000)) {
      throw new Error('Activation cooldowns must be between 0 and 60000 milliseconds')
    }
  }

  reserve(channel: string, user: string | undefined, now = Date.now()): number {
    for (const map of [this.users, this.channels]) {
      for (const [key, expiry] of map) if (expiry <= now) map.delete(key)
    }
    const start = Math.max(
      now,
      this.channels.get(channel) || 0,
      user ? this.users.get(user) || 0 : 0
    )
    this.channels.set(channel, start + this.channelMs)
    if (user) this.users.set(user, start + this.userMs)
    return start - now
  }
}
