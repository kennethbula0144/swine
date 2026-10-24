export default function EmptyState({ title, message }) {
  return (
    <div className="text-center text-muted py-5" role="status">
      <h5 className="mb-2">{title}</h5>
      <p className="mb-0">{message}</p>
    </div>
  );
}