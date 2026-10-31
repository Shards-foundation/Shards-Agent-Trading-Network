/**
 * Logout is a state-changing operation. A normal hyperlink issues GET, which
 * cannot reach the POST-only session revocation endpoint.
 */
export default function AuthAction({ signedIn }: { signedIn: boolean }) {
  if (!signedIn) {
    return (
      <a href="/join" className="satn-header-join">
        Join network <span aria-hidden="true">↗</span>
      </a>
    );
  }

  return (
    <form action="/api/auth/logout" method="post" className="satn-logout-form">
      <button type="submit" className="satn-header-join">
        Sign out <span aria-hidden="true">↗</span>
      </button>
    </form>
  );
}
