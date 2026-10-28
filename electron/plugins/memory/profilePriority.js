// Stable user traits first, then the user's current tasks, then other subjects.
function profilePriority({ subject, field }) {
  return subject.kind === "user" ? (field === "task" ? 1 : 0) : 2;
}

module.exports = { profilePriority };
