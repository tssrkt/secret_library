export function hasOutboundLibraryFriends(friends) {
  return Array.isArray(friends) && friends.some((friend) => friend?.outbound === true);
}
