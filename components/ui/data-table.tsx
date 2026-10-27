import type { ReactNode } from "react";
import { EmptyState, Skeleton } from "./primitives";
import styles from "./ui.module.css";

type Column<T> = { id: string; header: string; cell: (row: T) => ReactNode; rowHeader?: boolean };
type Props<T> = { caption: string; columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; emptyTitle: string; emptyDescription?: string; loading?: boolean; loadingLabel: string; error?: string };
export function DataTable<T>({ caption, columns, rows, rowKey, emptyTitle, emptyDescription, loading, loadingLabel, error }: Props<T>) {
  if (loading) return <Skeleton label={loadingLabel} />;
  if (error) return <p role="alert" className={styles.error}>{error}</p>;
  if (!rows.length) return <EmptyState title={emptyTitle} description={emptyDescription} />;
  return <div className={styles.tableScroll} role="region" aria-label={caption} tabIndex={0}><table className={styles.table}><caption>{caption}</caption><thead><tr>{columns.map((column) => <th key={column.id} scope="col">{column.header}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={rowKey(row)}>{columns.map((column) => column.rowHeader ? <th key={column.id} scope="row">{column.cell(row)}</th> : <td key={column.id}>{column.cell(row)}</td>)}</tr>)}</tbody></table></div>;
}
