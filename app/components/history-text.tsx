export function HistoryText({ text, speech }: { text: string; speech: string | null }) {
  if (!speech) return text;
  return (
    <>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{speech}</span>
    </>
  );
}
