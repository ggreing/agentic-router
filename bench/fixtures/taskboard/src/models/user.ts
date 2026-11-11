export interface User {
  id: string;
  name: string;
  email: string;
  /** Deactivated users keep their history but cannot receive new assignments. */
  active: boolean;
}
