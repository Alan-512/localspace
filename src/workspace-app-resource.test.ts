import assert from "node:assert/strict";
import { createWorkspaceAppResourceUri } from "./workspace-app-resource.js";

const firstBuild = createWorkspaceAppResourceUri(
  JSON.stringify({ entry: "workspace-app-first.js", css: ["first.css"] }),
);
assert.match(firstBuild, /^ui:\/\/localspace\/workspace-app-[0-9a-f]{16}\.html$/);
assert.equal(
  firstBuild,
  createWorkspaceAppResourceUri(
    JSON.stringify({ entry: "workspace-app-first.js", css: ["first.css"] }),
  ),
);

assert.notEqual(
  firstBuild,
  createWorkspaceAppResourceUri(
    JSON.stringify({ entry: "workspace-app-first.js", css: ["second.css"] }),
  ),
);

assert.throws(
  () => createWorkspaceAppResourceUri(""),
  /must not be empty/,
);
