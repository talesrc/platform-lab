import { useEffect, useState } from 'react';
import {
  Link,
  Progress,
  StatusError,
  StatusOK,
  StatusWarning,
  WarningPanel,
} from '@backstage/core-components';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/frontend-plugin-api';
import Table from '@material-ui/core/Table';
import TableBody from '@material-ui/core/TableBody';
import TableCell from '@material-ui/core/TableCell';
import TableHead from '@material-ui/core/TableHead';
import TableRow from '@material-ui/core/TableRow';
import Typography from '@material-ui/core/Typography';

// Response of GET /api/app-secrets/status (packages/backend/src/plugins/appSecrets.ts).
type AppSecret = {
  name: string;
  source: 'vault' | 'generated';
  used: boolean;
  status?: 'present' | 'deleted' | 'missing';
  version?: number;
  updatedTime?: string;
};

type EnvironmentSecrets = {
  env: string;
  secrets: AppSecret[];
  vaultUrl?: string;
  error?: string;
};

// The scorecard check secretsRotated (app-config.production.yaml).
const ROTATE_AFTER_DAYS = 90;

const days = (iso?: string) =>
  iso ? Math.floor((Date.now() - Date.parse(iso)) / 86_400_000) : undefined;

const State = ({ secret }: { secret?: AppSecret }) => {
  if (!secret) return <>-</>;
  if (secret.source === 'generated') {
    return <StatusOK>generated</StatusOK>;
  }
  if (!secret.status) return <StatusWarning>unknown</StatusWarning>;
  if (secret.status !== 'present') {
    return secret.used ? (
      <StatusError>{secret.status}</StatusError>
    ) : (
      <>{secret.status}</>
    );
  }
  const age = days(secret.updatedTime);
  const text = `v${secret.version}, ${age === undefined ? '?' : `${age}d`} old${
    secret.used ? '' : ' (unused)'
  }`;
  return age !== undefined && age > ROTATE_AFTER_DAYS ? (
    <StatusWarning>{text}</StatusWarning>
  ) : (
    <StatusOK>{text}</StatusOK>
  );
};

/**
 * Secrets of a golden-path app, one column per environment: present in Vault (version and
 * age, from metadata only), missing, or generated in the cluster. Values are never shown or
 * fetched; the environment headers link to Vault, where owners write them.
 */
export const SecretsTable = ({ entityRef }: { entityRef: string }) => {
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const [environments, setEnvironments] = useState<EnvironmentSecrets[]>();
  const [error, setError] = useState<Error>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const base = await discoveryApi.getBaseUrl('app-secrets');
      const response = await fetchApi.fetch(
        `${base}/status?entityRef=${encodeURIComponent(entityRef)}`,
      );
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return ((await response.json()) as { environments: EnvironmentSecrets[] })
        .environments;
    })()
      .then(result => !cancelled && setEnvironments(result))
      .catch(e => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [discoveryApi, fetchApi, entityRef]);

  if (error) {
    return (
      <WarningPanel
        title="Could not load the secrets"
        message={error.message}
      />
    );
  }
  if (!environments) return <Progress />;

  const names = [
    ...new Set(environments.flatMap(e => e.secrets.map(s => s.name))),
  ].sort();
  const problems = environments.filter(e => e.error);

  return (
    <>
      <Typography variant="subtitle2" style={{ marginTop: 16 }}>
        Secrets
      </Typography>
      {problems.map(e => (
        <Typography key={e.env} variant="body2" color="error">
          {e.env}: {e.error}
        </Typography>
      ))}
      {names.length === 0 ? (
        <Typography variant="body2">
          No secrets: the app sets no secretEnv or generatedSecretEnv.
        </Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Env var</TableCell>
              {environments.map(e => (
                <TableCell key={e.env}>
                  {e.vaultUrl ? <Link to={e.vaultUrl}>{e.env}</Link> : e.env}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {names.map(name => (
              <TableRow key={name}>
                <TableCell>
                  <code>{name}</code>
                </TableCell>
                {environments.map(e => (
                  <TableCell key={e.env}>
                    <State secret={e.secrets.find(s => s.name === name)} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
};
