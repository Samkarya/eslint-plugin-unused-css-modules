import styles from './Basic.module.scss';

export function Consumer({ variant }: { variant: string }) {
  return (
    <div className={styles.used}>
      <span className={styles[`dynamicPrefix${variant}`]} />
      <i className="global-only" />
    </div>
  );
}
