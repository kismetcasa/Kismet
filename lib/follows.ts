import { redis } from './redis'

const keyFollowing = (a: string) => `kismetart:following:${a.toLowerCase()}`
const keyFollowers = (a: string) => `kismetart:followers:${a.toLowerCase()}`

// MULTI/EXEC so a network failure can't half-write the graph: e.g.
// A->following has B but B->followers is missing A, which silently
// breaks fanoutToFollowers for that pair.
export async function follow(follower: string, target: string): Promise<void> {
  const f = follower.toLowerCase()
  const t = target.toLowerCase()
  await redis
    .multi()
    .sadd(keyFollowing(f), t)
    .sadd(keyFollowers(t), f)
    .exec()
}

export async function unfollow(follower: string, target: string): Promise<void> {
  const f = follower.toLowerCase()
  const t = target.toLowerCase()
  await redis
    .multi()
    .srem(keyFollowing(f), t)
    .srem(keyFollowers(t), f)
    .exec()
}

export async function isFollowing(follower: string, target: string): Promise<boolean> {
  const result = await redis.sismember(keyFollowing(follower.toLowerCase()), target.toLowerCase())
  return result === 1
}

export async function getFollowing(address: string): Promise<string[]> {
  return (await redis.smembers(keyFollowing(address.toLowerCase()))) as string[]
}

export async function getFollowers(address: string): Promise<string[]> {
  return (await redis.smembers(keyFollowers(address.toLowerCase()))) as string[]
}

export async function getFollowerCount(address: string): Promise<number> {
  return redis.scard(keyFollowers(address.toLowerCase()))
}

export async function getFollowingCount(address: string): Promise<number> {
  return redis.scard(keyFollowing(address.toLowerCase()))
}

/**
 * Remove `address` from the social graph entirely — both its own edge sets
 * AND the reciprocal membership in every counterpart's sets, so no ghost
 * edge survives. Used by admin profile-erase ("remove it from everywhere").
 *
 * Bidirectional cleanup: for every T that `address` followed, drop `address`
 * from T's followers; for every F that followed `address`, drop `address`
 * from F's following — then delete address's own two sets. Every
 * counterpart's follower/following COUNT (a live SCARD) self-corrects
 * because it no longer sees the erased member. Best-effort per edge so one
 * failed srem can't strand the rest; the final DELs always run.
 */
export async function purgeFollowEdges(address: string): Promise<void> {
  const a = address.toLowerCase()
  const [following, followers] = await Promise.all([
    getFollowing(a),
    getFollowers(a),
  ])
  await Promise.all([
    ...following.map((t) => redis.srem(keyFollowers(t), a).catch(() => {})),
    ...followers.map((f) => redis.srem(keyFollowing(f), a).catch(() => {})),
  ])
  await Promise.all([redis.del(keyFollowing(a)), redis.del(keyFollowers(a))])
}
