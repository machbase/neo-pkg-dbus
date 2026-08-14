import { useEffect, useState } from "react";
import { api } from "../api";

// The Data Viewer needs catalog flags (PRIMARY KEY, BASETIME and JSON) in addition to the
// three stored mapping names. Keep the lookup beside the ported viewer so every viewer mode
// shares one schema source.
export default function useTableColumns({ job, server, table }) {
  const [columns, setColumns] = useState([]);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!job || !server || !table) {
      setColumns([]);
      setChecked(false);
      return undefined;
    }
    let cancelled = false;
    setChecked(false);
    api.db.tables.columns({ job, server, table }).then(
      (data) => { if (!cancelled) setColumns(Array.isArray(data?.columns) ? data.columns : []); },
      () => { if (!cancelled) setColumns([]); },
    ).finally(() => { if (!cancelled) setChecked(true); });
    return () => { cancelled = true; };
  }, [job, server, table]);

  return { columns, checked };
}
