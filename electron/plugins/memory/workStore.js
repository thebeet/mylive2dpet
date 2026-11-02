const KINDS = new Set(["user", "person", "project", "team"]);
const FIELDS = new Set(["identity", "organization_role", "project_role", "responsibility", "team", "collaboration", "relationship", "task", "preference", "communication"]);
const clean = (value, max = 300) => typeof value === "string" ? value.trim().slice(0, max) : "";
const keyFor = ({ kind, name }) => kind === "user" ? "user:self" : `${kind}:${name.toLowerCase()}`;
function subjectOf(input) {
  if (!input || !KINDS.has(input.kind)) throw new Error("人物记忆人物或项目类型无效");
  const name = input.kind === "user" ? "用户" : clean(input.name, 80);
  if (!name) throw new Error("人物记忆名称不能为空");
  return { kind: input.kind, name };
}
function createWorkStore(storage, options) { return storage.repository("work-memory", options); }
module.exports = { createWorkStore, subjectOf, FIELDS };
