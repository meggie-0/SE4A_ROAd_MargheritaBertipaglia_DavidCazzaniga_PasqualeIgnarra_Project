import type { UserRole } from '@road/shared';
import { Column, Entity, PrimaryColumn } from 'typeorm';

import type { UserRecord } from '../persistence.port';

/**
 * `user` — passeggeri e operatori di flotta (RASD §2.2.1).
 *
 * Il ruolo distingue le due specializzazioni invece di due tabelle: le uniche differenze fra
 * `Passenger` e `FleetOperator` sono il numero di telefono e i permessi, e M1b applica questi
 * ultimi con i guard di Nest sul ruolo.
 *
 * `implements UserRecord` non è decorativo: è il compilatore a garantire che l'entità e il record
 * esposto dalla porta non divergano.
 */
@Entity({ name: 'user' })
export class UserEntity implements UserRecord {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'varchar', length: 320, unique: true })
  email!: string;

  /** Solo l'hash bcrypt (M1b). La password in chiaro non entra mai nel database né nei log. */
  @Column({ name: 'password_hash', type: 'varchar', length: 255 })
  passwordHash!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 120 })
  surname!: string;

  @Column({ name: 'phone_number', type: 'varchar', length: 40, nullable: true })
  phoneNumber!: string | null;

  @Column({ type: 'varchar', length: 20 })
  role!: UserRole;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
