/**
 * Fetches the list of available customer orgs from the Azure Functions API.
 * Returns an array of { id, name, region }.
 */
export async function fetchCustomers() {
  const resp = await fetch("/api/customers");
  if (!resp.ok) {
    throw new Error(`Failed to load customer list (${resp.status})`);
  }
  return resp.json();
}
