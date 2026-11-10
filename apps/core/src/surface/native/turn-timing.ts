// Turn timing shared by DM context selection, the outline, and conversation memory, so all of
// them split context windows identically. Both expressions read the turn row aliased as `t`.
export const TURN_CREATED_AT = `COALESCE((SELECT MIN(json_extract(m.value,'$.metadata.createdAt')) FROM json_each(t.data_json,'$.value.messages') m),json_extract(t.data_json,'$.value.startedAt'))`;

export function turnCompletedAtSql(recordsTable = "native_records"): string {
  return `MAX(COALESCE(json_extract(t.data_json,'$.value.settledAt'),0),
  COALESCE((SELECT MAX(json_extract(i.data_json,'$.value.completedAt')) FROM ${recordsTable} i WHERE i.kind='input' AND i.thread_id=t.thread_id AND i.position=t.position),0),
  COALESCE((SELECT MAX(json_extract(m.value,'$.metadata.createdAt')) FROM json_each(t.data_json,'$.value.messages') m),0))`;
}
