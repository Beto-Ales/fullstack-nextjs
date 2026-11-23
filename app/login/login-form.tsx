"use client";

import { useActionState } from "react";

import { PendingSubmit } from "@/app/components/pending-submit";
import { loginAction, type LoginActionState } from "@/app/login/actions";

type LoginFormProps = {
  returnTo?: string;
};

const initialState: LoginActionState = {};

export function LoginForm({ returnTo }: LoginFormProps) {
  const [state, formAction] = useActionState(loginAction, initialState);

  return (
    <form action={formAction}>
      <div>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div>
        <label htmlFor="password">Contraseña</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
      {state.error ? (
        <p role="alert">
          {state.error}
        </p>
      ) : null}
      <PendingSubmit label="Iniciar sesión" pendingLabel="Entrando…" />
    </form>
  );
}

