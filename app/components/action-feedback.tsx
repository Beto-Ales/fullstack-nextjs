"use client";

import { useEffect, useRef } from "react";

export function ActionFeedback({ error, confirmation }: { error?: string; confirmation?: string }) {
  const feedback = useRef<HTMLParagraphElement>(null);
  const message = error ?? confirmation;
  useEffect(() => {
    if (message) feedback.current?.focus();
  }, [message]);
  if (!message) return null;
  return <p ref={feedback} tabIndex={-1} role={error ? "alert" : "status"}>{message}</p>;
}
