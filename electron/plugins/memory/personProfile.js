const PERSON_FIELDS = new Set(["identity", "organization_role", "project_role", "responsibility", "team", "collaboration", "relationship", "preference", "communication"]);

function isPersonProfile({ subject, field, scope, value, basis }) {
  if (!["user", "person"].includes(subject?.kind) || !PERSON_FIELDS.has(field)) return false;
  if (basis === "user_answer") return true;
  if (["collaboration", "communication"].includes(field) && scope && typeof value === "string") {
    const stable = /经常|长期|通常|习惯|偏好|朋友|亲属|家人|同事|伴侣|协作伙伴/.test(value);
    const episode = /讨论|询问|回复|表示|截图|发言/.test(value);
    const technical = /接口|工单|结算|灰度|预发|发布|流水线|分支|代码|权限|GitLab|Report\.json|episode|\bMR\b|\btag\b|\bmain\b/i.test(`${scope} ${value}`);
    if (!stable && episode && technical) return false;
  }
  return true;
}

module.exports = { isPersonProfile };
