function configuredLineUserIds(value = process.env.LINE_ALLOWED_USER_IDS): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((userId) => userId.trim())
      .filter(Boolean),
  );
}

export function isLineUserAllowed(
  userId: string,
  value = process.env.LINE_ALLOWED_USER_IDS,
): boolean {
  const allowedUserIds = configuredLineUserIds(value);
  return allowedUserIds.size === 0 || allowedUserIds.has(userId);
}
