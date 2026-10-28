export type Role = 'super' | 'ops' | 'finance';

export interface Me {
  id: number;
  username: string;
  role: Role;
}
