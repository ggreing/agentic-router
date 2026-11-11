import type { User } from '../models/user.ts';

export class InMemoryUserRepo {
  #users = new Map<string, User>();

  constructor(seed: User[] = []) {
    for (const user of seed) this.#users.set(user.id, { ...user });
  }

  insert(user: User): User {
    if (this.#users.has(user.id)) throw new Error(`Duplicate user id: ${user.id}`);
    this.#users.set(user.id, { ...user });
    return { ...user };
  }

  findById(id: string): User | undefined {
    const user = this.#users.get(id);
    return user ? { ...user } : undefined;
  }

  list(): User[] {
    return [...this.#users.values()].map((user) => ({ ...user }));
  }
}
