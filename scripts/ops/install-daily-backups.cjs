// Compatibility entry: the user's weekly/monthly policy replaces the old daily setup.
const {installSchedules}=require('./install-backup-schedules.cjs');
if(require.main===module)installSchedules(process.argv[2]||'/tmp/dianjie-backup-schedules-20261027');
