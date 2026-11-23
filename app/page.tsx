import Link from "next/link";

const Home = () => {
  return (
    <main id="contenido-principal" tabIndex={-1}>
      <p><Link href="/login">Iniciar sesión</Link></p>
      <div lang="en">
        <h2>notes app</h2>
        An example app for{" "}
        <a href="https://courses.mooc.fi/org/uh-cs/courses/full-stack-open-nextjs">
          Full Stack Open Next.js
        </a>
      </div>
      <div lang="en">
        See{" "}
        <a href="https://github.com/fullstack-hy2020/nextjs-notes">
          https://github.com/fullstack-hy2020/nextjs-notes
        </a>{" "}
        for the source code
      </div>
    </main>
  )
}
export default Home
