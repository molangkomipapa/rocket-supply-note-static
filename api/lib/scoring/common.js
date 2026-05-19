export function makeScore(category, code, checks, labels) {
  const passed = checks.filter((x) => x.points > 0);
  const failed = checks.filter((x) => x.points <= 0).map((x) => x.label);
  const score = Math.min(
    100,
    checks.reduce((sum, x) => sum + Math.max(0, x.points), 0)
  );

  return {
    category,
    code,
    score,
    status: getGrade(score, labels),
    passed: passed.map((x) => x.label),
    failed,
    checks: checks.map((x) => ({
      label: x.label,
      ok: x.points > 0,
      points: x.points
    }))
  };
}

export function getGrade(score, labels) {
  if (score >= 80) return labels[0];
  if (score >= 65) return labels[1];
  if (score >= 50) return labels[2];
  return labels[3];
}
