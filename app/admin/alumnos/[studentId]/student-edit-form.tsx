"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import type { StudentEditData } from "@/src/application/academic/student-edit-schema";
import type { StudentEditState } from "./student-edit-action";
import styles from "./profile.module.css";

const fields = [
  { name: "firstName", label: "Nombre", type: "text", maxLength: 120, required: true },
  { name: "lastName", label: "Apellidos", type: "text", maxLength: 120, required: true },
  { name: "email", label: "Correo de acceso", type: "email", maxLength: 255, required: true },
  { name: "contactEmail", label: "Correo de contacto (opcional)", type: "email", maxLength: 255, required: false },
  { name: "contactPhone", label: "Teléfono de contacto (opcional)", type: "tel", maxLength: 60, required: false },
] as const;

export function StudentEditForm({ initial, action, cancelHref }: {
  initial: StudentEditData;
  action: (previous: StudentEditState, form: FormData) => Promise<StudentEditState>;
  cancelHref: string;
}) {
  const [state, submit, pending] = useActionState(action, { status: "idle" });
  const [values, setValues] = useState(initial);
  const [edited, setEdited] = useState(false);
  const fieldErrors = state.status === "error" ? state.fields : undefined;
  const saved = state.status === "success" && !edited && !pending;
  return (
    <section aria-labelledby="editar-datos">
      <h2 id="editar-datos">Editar datos</h2>
      <p>El correo de acceso se utiliza para iniciar sesión.</p>
      {saved && <p role="status">{state.message}</p>}
      {(state.status === "error" || state.status === "conflict") && <p role="alert">{state.message}</p>}
      {state.status === "conflict" && (
        <button type="button" onClick={() => window.location.reload()}>Recargar datos</button>
      )}
      <form action={submit} onSubmit={() => setEdited(false)} noValidate aria-busy={pending} className={styles.editForm}>
        <fieldset disabled={pending || state.status === "conflict"}>
          <legend>Datos personales y de contacto</legend>
          {fields.map(({ name, label, type, maxLength, required }) => (
            <div key={name}>
              <label htmlFor={name}>{label}</label>
              <input id={name} name={name} type={type} maxLength={maxLength} required={required}
                value={values[name] ?? ""} onChange={(event) => {
                  setEdited(true);
                  setValues({ ...values, [name]: event.target.value });
                }}
                aria-invalid={fieldErrors?.[name] ? true : undefined}
                aria-describedby={fieldErrors?.[name] ? `${name}-error` : undefined} />
              {fieldErrors?.[name] && <p id={`${name}-error`}>{fieldErrors[name]}</p>}
            </div>
          ))}
          <button type="submit">{pending ? "Guardando…" : "Guardar cambios"}</button>
        </fieldset>
        <Link href={cancelHref} prefetch={false}>{saved ? "Cerrar edición" : "Cancelar"}</Link>
      </form>
    </section>
  );
}
