/** Remove Git's repository selectors before a child process touches a checkout or fixture. */
export function sanitizedGitEnvironment(environment = process.env) {
  const child = { ...environment };
  for (const key of Object.keys(child)) {
    if (key.startsWith("GIT_")) delete child[key];
  }
  return child;
}
