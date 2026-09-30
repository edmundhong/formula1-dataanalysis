export interface CalendarRow {
  id: string;
  starts_at: string;
  status?: string;
  artifact_path?: string | null;
}
export function calendarChanges(
  existing: CalendarRow[],
  incoming: CalendarRow[],
) {
  const rows = new Map(incoming.map((s) => [s.id, s]));
  return {
    removed: existing
      .filter((s) => !rows.has(s.id) && !s.artifact_path)
      .map((s) => s.id),
    returned: existing
      .filter((s) => s.status === "cancelled" && rows.has(s.id))
      .map((s) => s.id),
    moved: existing
      .filter(
        (s) =>
          rows.has(s.id) &&
          Date.parse(s.starts_at) !== Date.parse(rows.get(s.id)!.starts_at),
      )
      .map((s) => s.id),
  };
}
export function publicationPath(id: string, year: number, version: string) {
  if (
    !/^[a-f0-9]{20}$/.test(version) ||
    !/^20\d{2}-\d{2}-(FP[123]|Q|SQ|S|R)$/.test(id) ||
    Number(id.slice(0, 4)) !== year ||
    year !== 2026
  )
    throw new Error("Invalid publication identity");
  return `${year}/${id}/${version}.json`;
}
