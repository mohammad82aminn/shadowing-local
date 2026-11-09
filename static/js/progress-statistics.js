const ADDRESSED_STATUSES = new Set([
  "completed",
  "attempted-incorrect",
  "skipped",
]);

function isActiveCue(cue) {
  return cue?.activeVersion !== false && cue?.active !== false;
}

export function computeProgressStatistics(cues = []) {
  const activeCues = cues.filter(isActiveCue);
  const completedCount = activeCues.filter((cue) => cue.status === "completed").length;
  const coveredCount = activeCues.filter((cue) => ADDRESSED_STATUSES.has(cue.status)).length;
  const answeredCues = activeCues.filter((cue) => Array.isArray(cue.attempts) && cue.attempts.length > 0);
  const firstAttemptCorrectCount = answeredCues.filter((cue) => cue.attempts[0]?.correct === true).length;

  return {
    correctCompletion: {
      numerator: completedCount,
      denominator: activeCues.length,
    },
    coverage: {
      numerator: coveredCount,
      denominator: activeCues.length,
    },
    firstAttemptAccuracy: {
      numerator: firstAttemptCorrectCount,
      denominator: answeredCues.length,
    },
  };
}

function formatMetric(metric) {
  if (metric.denominator === 0) return "— (۰ / ۰)";
  const percentage = Math.round((metric.numerator / metric.denominator) * 100);
  return `${metric.numerator.toLocaleString("fa-IR")} / ${metric.denominator.toLocaleString("fa-IR")} (${percentage.toLocaleString("fa-IR")}٪)`;
}

function renderStatistics(container, cues) {
  const statistics = computeProgressStatistics(cues);
  for (const [name, metric] of Object.entries(statistics)) {
    const value = container.querySelector(`[data-progress-value="${name}"]`);
    const bar = container.querySelector(`[data-progress-bar="${name}"]`);
    const percentage = metric.denominator === 0 ? 0 : (metric.numerator / metric.denominator) * 100;
    value.textContent = formatMetric(metric);
    bar.querySelector(".progress-bar").style.width = `${percentage}%`;
    bar.setAttribute("aria-valuenow", String(Math.round(percentage)));
    bar.setAttribute("aria-valuetext", formatMetric(metric));
  }
}

const container = typeof document === "undefined"
  ? null
  : document.querySelector("[data-progress-statistics]");

if (container) {
  let projectId = null;
  let cues = [];

  window.addEventListener("shadowing:practiceprojectloaded", (event) => {
    projectId = event.detail?.project?.id || null;
    cues = event.detail?.cues || [];
    renderStatistics(container, cues);
  });

  window.addEventListener("shadowing:cueprogress", (event) => {
    const updated = event.detail?.cue;
    if (!updated || updated.projectId !== projectId) return;
    cues = cues.map((cue) => cue.id === updated.id ? updated : cue);
    renderStatistics(container, cues);
  });

  window.addEventListener("shadowing:workspacechange", () => {
    projectId = null;
    cues = [];
    renderStatistics(container, cues);
  });
}
