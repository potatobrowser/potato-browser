# Security policy

Please report vulnerabilities privately, not in a public issue.

Use **Report a vulnerability** on the [Security tab](https://github.com/potatobrowser/potato-browser/security/advisories/new)
of this repository. Include what an attacker needs (a web page, a network position, local access),
the steps to reproduce, and the version from Settings, About.

In scope:

- the browser (`apps/browser`): anything a web page can do that it should not, such as reaching
  internal `potato://` pages, privileged IPC, local files, permissions it was not granted, or
  data from private windows;
- the flags service and site (`apps/web`): ways to change flag counts beyond one vote per network,
  to learn who flagged what, or to read stored data;
- the release pipeline: anything that could put code into a release that is not in this
  repository at the tagged commit.

Fixes ship in a new release, and the advisory is published once that release is out. Only the
latest release gets fixes.
