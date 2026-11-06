"""Interrupted resume guards; these are not compatible-package business proof."""
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import rehearse_compatible_switch as switch
import switch_journal
from test_switch_journal import metadata
from test_rehearse_compatible_switch import plan


def record():
    r=metadata();p=plan()
    r.update(format=1,phase='creating_api',controllerSha256=switch.gate.checksum(Path(switch.__file__)))
    for role in ('api','web'):
        r['previous'][role]['imageId']=p['previous'][role]['imageId']
    return r


class ResumeTests(unittest.TestCase):
    def test_requires_same_plan_controller_images_and_nonterminal_phase(self):
        r=record();switch.validate_resume_record(r,plan(),'a'*64,r['candidateImages'])
        for key,value in [('planSha256','f'*64),('controllerSha256','f'*64),('phase','switched'),('network','dianjie-compat-other')]:
            changed=copy.deepcopy(r);changed[key]=value
            with self.assertRaises(switch.gate.Refused):
                switch.validate_resume_record(changed,plan(),'a'*64,r['candidateImages'])

    def test_resume_never_overwrites_checkpoint_until_an_action_starts(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'journal';r=record();j=switch_journal.Journal(p,{k:v for k,v in r.items() if k not in ('format','phase')});j.write(r['phase'])
            before=p.read_bytes();runtime=switch.DockerSwitch(plan(),{}, {},r['candidateImages'])
            runtime.resume_journal(p,r)
            self.assertEqual(p.read_bytes(),before)
            self.assertEqual(runtime.names,r['candidateNames']);self.assertTrue(runtime.resuming)
            changed=copy.deepcopy(r);changed['phase']='draining'
            with self.assertRaises(switch_journal.JournalError):switch_journal.Journal.resume(p,changed)

    def test_resume_removes_partial_candidates_before_idempotent_drain(self):
        r=record();previous={role:{'Id':r['previous'][role]['id']} for role in ('api','web')}
        runtime=switch.DockerSwitch(plan(),previous,{},r['candidateImages']);runtime.resuming=True
        calls=[]
        with patch.object(runtime,'remove_candidate',side_effect=lambda:calls.append('remove')),patch.object(switch,'docker',side_effect=lambda *a:calls.append(a) or ''),patch.object(switch,'inspect_container',return_value={'State':{'Running':False},'NetworkSettings':{'Networks':{}}}):
            runtime.drain()
        self.assertEqual(calls[0],'remove');self.assertEqual(len(calls),3)
        self.assertTrue(all(c[0]=='stop' for c in calls[1:]))


class RuntimeReconciliationTests(unittest.TestCase):
    def test_partial_runtime_requires_exact_ids_network_ports_and_configuration(self):
        import json
        r=record();p=plan();url='postgresql://synthetic:synthetic@127.0.0.1:15449/dianjie_four_gap_test'
        env={'DATABASE_URL':url.replace('127.0.0.1:15449','db:5432'),'PREVIEW_MODE':'true','PREVIEW_TENANT_SLUG':'four-gap-local-20261028','CMB_AUTOPAY_ENABLED':'false','CMB_INTERNAL_TRANSFER_ENABLED':'false','SENTRY_DSN':'','NODE_ENV':'production','CREDENTIAL_ENCRYPTION_KEYS':'synthetic'}
        db={'Id':'db','Config':{'Labels':{'org.dianjie.operation':'four-gap-20261028'}},'State':{'Running':True},'HostConfig':{'PortBindings':{'5432/tcp':[{'HostIp':'127.0.0.1','HostPort':'15449'}]}}}
        previous={role:{'Id':r['previous'][role]['id'],'Name':r['previous'][role]['name'],'Image':r['previous'][role]['imageId'],'State':{'Running':False},'Config':{'Labels':{'org.dianjie.operation':switch.OPERATION,'org.dianjie.role':role},'Env':[k+'='+v for k,v in env.items()]},'NetworkSettings':{'Networks':{}},'HostConfig':{'PortBindings':{} if role=='api' else {'3000/tcp':[{'HostIp':'127.0.0.1','HostPort':'3263'}]}}} for role in ('api','web')}
        candidate=copy.deepcopy(previous['api']);candidate.update(Id='c'*64,Name='/'+r['candidateNames']['api'],Image=r['candidateImages']['api']);candidate['Config']['Labels']['org.dianjie.recovery-id']=r['operationId'];candidate['NetworkSettings']['Networks']={p['network']:{}}
        def run(mutate=None):
            current=copy.deepcopy(candidate);old=copy.deepcopy(previous)
            if mutate:mutate(current,old)
            def docker(*args):
                if args[:2]==('context','inspect'):return json.dumps([{'Endpoints':{'docker':{'Host':'unix://'+str(Path.home()/'.colima/dianjie-huawei/docker.sock')}}}])
                if args[:2]==('network','inspect'):return json.dumps([{'Driver':'bridge','Internal':False,'Labels':{'org.dianjie.operation':switch.OPERATION},'Containers':{'db':{},'c'*64:{}}}])
                if args[0]=='ps':return 'c'*64 if r['candidateNames']['api'] in args[-1] else ''
                raise AssertionError(args)
            def inspect(name):
                if name==switch.DB:return db
                if name=='c'*64:return current
                return next(v for v in old.values() if v['Name']=='/'+name)
            with patch.object(switch,'docker',side_effect=docker),patch.object(switch,'inspect_container',side_effect=inspect),patch.object(switch.gate,'database_env',return_value={}),patch.object(switch.gate,'keyring_fingerprint',side_effect=lambda v:v):
                return switch.validate_runtime(p,url,'synthetic',r)
        self.assertEqual(run()[1],env)
        for mutate in [lambda c,o:o['api'].update(Id='f'*64),lambda c,o:c.update(Image='sha256:'+'f'*64),lambda c,o:c['NetworkSettings'].update(Networks={'bridge':{}}),lambda c,o:c['HostConfig'].update(PortBindings={'4000/tcp':[{'HostIp':'0.0.0.0','HostPort':'4000'}]}),lambda c,o:c['Config'].update(Env=['DATABASE_URL=wrong'])]:
            with self.assertRaises(switch.gate.Refused):run(mutate)

class MainEntryTests(unittest.TestCase):
    """Exercise CLI dispatch past preflight; all external operations are mocked."""
    def run_entry(self, resume=False, execute=True, failure=False, recovery_kind=None):
        from contextlib import ExitStack, redirect_stdout
        from types import SimpleNamespace
        from unittest.mock import Mock
        import io, json
        r=record(); p=plan(); images=r['candidateImages']
        if recovery_kind == 'same-version-redeploy':
            images={role:item['imageId'] for role,item in p['previous'].items()}; r['candidateImages']=images
        args=SimpleNamespace(plan=Path('plan'), approved_plan_sha256='a'*64,
            candidate_root=Path('candidate'), compat_manifest=Path('manifest'),
            approved_manifest_sha256='b'*64, execute=execute, resume=resume)
        manifest={'packageKind':'compatible-rollback','runtimeImages':images,
            'rollbackDriver':'scripts/release/'+Path(switch.__file__).name,
            'artifacts':{'scripts/release/'+path.name:'pinned' for path in
                (Path(switch.__file__),Path(switch.gate.__file__),Path(switch_journal.__file__),switch.AUDIT_PATH)}}
        if recovery_kind:
            manifest.update(packageKind='compatible-recovery',recoveryKind=recovery_kind,
                recoverySourceImages={role:item['imageId'] for role,item in p['previous'].items()})
        runtime=Mock(); audit=SimpleNamespace(image_identity=lambda path:images[path.parts[0]])
        spec=SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module:None))
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            root=Path(tmp); (root/'.codex').mkdir()
            def patched(target,name,**kwargs):
                return stack.enter_context(patch.object(target,name,**kwargs))
            patched(switch.argparse.ArgumentParser,'parse_args',return_value=args)
            patched(switch,'read_pinned',side_effect=[p,manifest])
            patched(switch.gate,'checksum',return_value='pinned')
            patched(switch.importlib.util,'spec_from_file_location',return_value=spec)
            patched(switch.importlib.util,'module_from_spec',return_value=audit)
            patched(switch.gate,'safe_file',side_effect=lambda root,rel:Path(rel))
            for name,value in [('database_env',{}),('inspect_state',{}),('verify_package',{}),('keyring_ids',[]),('keyring_fingerprint','synthetic')]:
                patched(switch.gate,name,return_value=value)
            patched(Path,'home',return_value=root)
            read=patched(switch_journal,'read',return_value=r)
            pending=patched(switch_journal,'check_no_pending')
            patched(switch,'validate_resume_record')
            validate=patched(switch,'validate_runtime',return_value=({},{}))
            patched(switch,'docker',side_effect=lambda *a:json.dumps([{'Id':a[-1],'Os':'linux','Architecture':'amd64'}]))
            patched(switch,'DockerSwitch',return_value=runtime)
            run=patched(switch,'switch_runtime',return_value={'status':'synthetic'},side_effect=RuntimeError('synthetic') if failure else None)
            signals=patched(switch.signal,'signal',return_value='previous-handler')
            with redirect_stdout(io.StringIO()): status=switch.main()
            self.assertEqual(status,1 if failure else 0)
            self.assertIs(validate.call_args.args[-1],r if resume else None)
            self.assertEqual(read.call_count,1 if resume else 0)
            self.assertEqual(pending.call_count,0 if resume else 1)
            if execute:
                if resume:
                    runtime.resume_journal.assert_called_once_with(root/'.codex/dianjie-compatible-rehearsal.journal.json',r)
                    runtime.enable_journal.assert_not_called()
                else:
                    runtime.enable_journal.assert_called_once()
                    runtime.resume_journal.assert_not_called()
                run.assert_called_once()
                handler=signals.call_args_list[0].args[1]
                with self.assertRaises(KeyboardInterrupt):handler(None,None)
                self.assertEqual(signals.call_args_list[-1].args,(switch.signal.SIGTERM,'previous-handler'))
            else:
                run.assert_not_called(); signals.assert_not_called()
                runtime.enable_journal.assert_not_called(); runtime.resume_journal.assert_not_called()

    def test_explicit_same_version_cli_reaches_guarded_execute_and_resume(self):
        self.run_entry(recovery_kind='same-version-redeploy')
        self.run_entry(resume=True,recovery_kind='same-version-redeploy')
    def test_explicit_software_rollback_cli_retains_guarded_execution(self):
        self.run_entry(recovery_kind='compatible-version-rollback')
    def test_normal_execute_creates_new_journal(self): self.run_entry()
    def test_resume_execute_passes_record_not_signal_handler(self): self.run_entry(resume=True)
    def test_dry_runs_never_switch_or_install_signal_handler(self):
        self.run_entry(execute=False); self.run_entry(resume=True,execute=False)
    def test_execution_failure_restores_original_signal_handler(self): self.run_entry(failure=True)


if __name__=='__main__':unittest.main()
