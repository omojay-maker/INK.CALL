interface RedisRegistryClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] }
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export class CallRegistry {
  private readonly local = new Map<number, string>();

  constructor(private readonly redis?: RedisRegistryClient) {}

  async reserve(callId: string, firstUserId: number, secondUserId: number): Promise<boolean> {
    if (!this.redis) {
      if (this.local.has(firstUserId) || this.local.has(secondUserId)) return false;
      this.local.set(firstUserId, callId);
      this.local.set(secondUserId, callId);
      return true;
    }

    const result = await this.redis.eval(
      `local first = KEYS[1]
       local second = KEYS[2]
       if redis.call('EXISTS', first) == 1 or redis.call('EXISTS', second) == 1 then
         return 0
       end
       redis.call('SET', first, ARGV[1], 'EX', ARGV[2])
       redis.call('SET', second, ARGV[1], 'EX', ARGV[2])
       return 1`,
      {
        keys: [`ink:call:user:${firstUserId}`, `ink:call:user:${secondUserId}`],
        arguments: [callId, "21600"]
      }
    );
    return Number(result) === 1;
  }

  async is(callId: string, userId: number): Promise<boolean> {
    if (!this.redis) return this.local.get(userId) === callId;
    return await this.redis.get(`ink:call:user:${userId}`) === callId;
  }

  async get(userId: number): Promise<string | null> {
    if (!this.redis) return this.local.get(userId) ?? null;
    return await this.redis.get(`ink:call:user:${userId}`);
  }

  async release(callId: string, ...userIds: number[]): Promise<void> {
    if (!this.redis) {
      for (const userId of userIds) {
        if (this.local.get(userId) === callId) this.local.delete(userId);
      }
      return;
    }

    const keys = userIds.map((userId) => `ink:call:user:${userId}`);
    if (keys.length === 0) return;
    await this.redis.eval(
      `for index, key in ipairs(KEYS) do
         if redis.call('GET', key) == ARGV[1] then redis.call('DEL', key) end
       end
       return 1`,
      { keys, arguments: [callId] }
    );
  }
}
