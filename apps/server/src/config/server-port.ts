export function serverPort(value = process.env.PORT ?? "3030"): number {
  if (!/^\d{1,5}$/u.test(value)) throw new Error("PORT must be an integer between 0 and 65535");
  const port = Number(value);
  if (port > 65535) throw new Error("PORT must be an integer between 0 and 65535");
  return port;
}
